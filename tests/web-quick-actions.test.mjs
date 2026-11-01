import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import ts from "typescript"
import { decide } from "../dist/config/policy.js"

function compile(file, replacements) {
  let source = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  for (const [from, to] of replacements) source = source.replaceAll(from, to)
  return "data:text/javascript;base64," + Buffer.from(source).toString("base64")
}
const policy = new URL("../dist/config/policy.js", import.meta.url).href
const rules = compile("../web/src/lib/rules.ts", [
  ["../../../src/config/policy.js", policy],
  [
    "../../../src/config/sample-policy.js",
    new URL("../dist/config/sample-policy.js", import.meta.url).href,
  ],
])
const { eventShortcutProblem, addEventShortcut, applyPermissionPreset, siteShortcutTarget } =
  await import(
    compile("../web/src/lib/quick-actions.ts", [
      ["../../../src/config/policy.js", policy],
      ["./rules", rules],
      ["./policy.js", new URL("../web/src/lib/policy.js", import.meta.url).href],
    ])
  )
const entry = {
  id: "sample",
  time: 1,
  type: "audit",
  plugin: "alpha",
  kind: "network",
  operation: "fetch",
  target: "https://example.test/api",
  action: "deny",
  details: { secret: "do-not-copy" },
}
const match = (document, event = entry) =>
  decide({ ...event, action: undefined }, document.rules ?? [])

test("事件快捷放行精确覆盖首条规则，保留其他插件、目标与操作的处置", () => {
  const broad = { id: "all-network", kind: "network", action: "deny" }
  const document = { rules: [broad] }
  addEventShortcut(document, entry, "audit", "panel.event.sample")
  assert.equal(match(document).action, "audit")
  for (const change of [
    { plugin: "alpha-extra" },
    { target: "https://example.test/other" },
    { operation: "http.get" },
  ])
    assert.equal(match(document, { ...entry, ...change }).action, "deny")
  assert.equal(document.rules[1], broad)
  assert.equal(JSON.stringify(document).includes("do-not-copy"), false)
  assert.throws(() => addEventShortcut(document, entry, "audit", "another"), /当前配置已/)
  assert.equal(document.rules.length, 2)
})

test("快捷操作拒绝未知来源、脱敏目标、字面通配符、系统观察与自保护，不扩大授权", () => {
  const changes = [
    { plugin: "unknown" },
    { plugin: "yunzai-guard" },
    { plugin: "alpha*" },
    { target: "" },
    { target: "—" },
    { target: "https://example.test/[path-redacted]" },
    { target: "https://example.test/a?token=1" },
    { target: "[truncated]" },
    { target: "x".repeat(513) },
    { kind: "process", operation: "exec", target: "node" },
    { operation: "connection.observed" },
    { details: { enforcement: "after-change" } },
    { kind: "integrity" },
    { kind: "self-protection" },
    { kind: "system" },
    { action: "info" },
  ]
  for (const change of changes) {
    const sample = { ...entry, ...change }
    const document = { rules: [] }
    assert.ok(eventShortcutProblem(sample), JSON.stringify(change))
    assert.throws(() => addEventShortcut(document, sample, "deny", "never"))
    assert.deepEqual(document.rules, [])
  }
  const document = {
    rules: Array.from({ length: 1000 }, (_, i) => ({ id: String(i), action: "audit" })),
  }
  assert.throws(() => addEventShortcut(document, entry, "deny", "extra"), /1000/)
})

test("限制外部命令套餐覆盖异步和同步入口，保留线程、其他插件及现有规则", () => {
  const document = { rules: [{ id: "global", action: "audit" }] }
  applyPermissionPreset(document, ["alpha", "beta", "alpha"], "commands")
  assert.equal(document.rules.length, 7)
  for (const plugin of ["alpha", "beta"])
    for (const operation of [
      "exec",
      "execSync",
      "execFile",
      "execFileSync",
      "spawn",
      "spawnSync",
      "fork",
    ])
      assert.equal(match(document, { ...entry, plugin, kind: "process", operation }).action, "deny")
  assert.equal(match(document, { ...entry, kind: "process", operation: "worker" }).action, "audit")
  assert.equal(
    match(document, { ...entry, plugin: "other", kind: "process", operation: "spawn" }).action,
    "audit",
  )
  assert.equal(match(document).action, "audit")
  applyPermissionPreset(document, ["alpha"], "commands")
  assert.equal(document.rules.length, 7)
})

test("站点快捷操作显式选择范围，保持协议、端口、来源及操作，不伪造精确路径", () => {
  const redacted = { ...entry, target: "https://example.test:8443/[path-redacted]" }
  assert.ok(eventShortcutProblem(redacted))
  assert.equal(eventShortcutProblem(redacted, "site"), undefined)
  assert.equal(siteShortcutTarget(redacted), "https://example.test:8443/*")
  const document = { rules: [{ id: "block", kind: "network", action: "deny" }] }
  addEventShortcut(document, redacted, "audit", "site", "site")
  assert.equal(document.rules[0].target, "https://example.test:8443/*")
  assert.equal(
    match(document, { ...entry, target: "https://example.test:8443/other" }).action,
    "audit",
  )
  for (const change of [
    { target: "https://example.test:443/other" },
    { target: "http://example.test:8443/other" },
    { target: "https://example.test.evil:8443/other" },
    { plugin: "other" },
    { operation: "http.get" },
  ])
    assert.equal(match(document, { ...redacted, ...change }).action, "deny")
  assert.throws(
    () => addEventShortcut(document, redacted, "audit", "duplicate", "site"),
    /当前配置已/,
  )
  for (const target of [
    "file:///a/[path-redacted]",
    "https://user:pass@example.test/[path-redacted]",
    "https://*.test/[path-redacted]",
  ])
    assert.equal(siteShortcutTarget({ ...entry, target }), undefined)
})

test("联网和继承套餐限定所选插件，继承移除精确专属规则并保留全局及沙箱设置", () => {
  const global = { id: "global", kind: "network", action: "audit" }
  const manual = { id: "manual", plugin: "alpha", kind: "network", action: "deny" }
  const sandbox = { native: { plugins: [{ id: "alpha", enabled: true }] } }
  const document = { rules: [manual, global], pluginSandbox: sandbox }
  applyPermissionPreset(document, ["alpha", "beta"], "network")
  assert.equal(match(document).action, "deny")
  assert.equal(match(document, { ...entry, plugin: "beta" }).action, "deny")
  assert.equal(match(document, { ...entry, plugin: "alpha-extra" }).action, "audit")
  applyPermissionPreset(document, ["alpha"], "inherit")
  assert.equal(match(document).ruleId, "global")
  assert.equal(match(document, { ...entry, plugin: "beta" }).action, "deny")
  assert.equal(document.rules.includes(manual), false)
  assert.equal(document.pluginSandbox, sandbox)
  const before = structuredClone(document)
  assert.throws(() => applyPermissionPreset(document, ["beta", "yunzai-guard"], "inherit"))
  assert.deepEqual(document, before)
})
