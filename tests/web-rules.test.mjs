import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import ts from "typescript"

const source = fs.readFileSync(new URL("../web/src/lib/rules.ts", import.meta.url), "utf8")
const compiled = ts
  .transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  })
  .outputText.replace(
    "../../../src/config/policy.js",
    new URL("../dist/config/policy.js", import.meta.url).href,
  )
const { canCreateRule, eventRule, matchingRules, needsTarget } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled).toString("base64")
)
const entry = {
  id: "event-1",
  time: 1,
  type: "audit",
  plugin: "demo-plugin",
  kind: "network",
  operation: "fetch",
  target: "https://example.test/api",
  action: "deny",
  details: { token: "not-a-rule" },
}

test("从事件生成规则保留来源与条件，默认记录，不复制私密详情或放行自身保护", () => {
  assert.equal(canCreateRule(entry), true)
  assert.deepEqual(eventRule(entry), {
    action: "audit",
    plugin: "demo-plugin",
    kind: "network",
    operation: "fetch",
    target: entry.target,
  })
  assert.equal(eventRule({ ...entry, plugin: "unknown" }).plugin, "unknown")
  for (const kind of ["self-protection", "coverage", "system", "guard", "runtime"])
    assert.equal(canCreateRule({ ...entry, kind }), false)
  assert.equal(canCreateRule({ ...entry, action: "info" }), false)
  assert.equal("target" in eventRule({ ...entry, target: "—" }), false)
})

test("样本预览复用首条匹配语义，区分命中与生效，中文插件名及通配保持一致", () => {
  const rule = {
    id: "specific",
    kind: "network",
    plugin: "demo-*",
    operation: "fetch",
    target: "https://example.test/*",
    action: "deny",
  }
  const broad = { id: "first", action: "audit" }
  const samples = [
    entry,
    { ...entry, id: "different-operation", operation: "http.get" },
    { ...entry, id: "different-plugin", plugin: "其他插件" },
  ]
  assert.deepEqual(
    matchingRules(rule, [broad, rule], samples).map(row => [row.entry.id, row.first]),
    [["event-1", "first"]],
  )
  assert.deepEqual(
    matchingRules(rule, [rule, broad], samples).map(row => [row.entry.id, row.first]),
    [["event-1", "specific"]],
  )
  const unicode = { ...rule, plugin: "其他*" }
  assert.equal(matchingRules(unicode, [unicode], samples)[0].entry.plugin, "其他插件")
  assert.equal(entry.action, "deny")
})

test("脱敏 URL 生成站点规则，精确路径和隐藏命令参数不会被伪造为验证通过", () => {
  const redacted = { ...entry, target: "https://example.test/[path-redacted]" }
  assert.equal(eventRule(redacted).target, "https://example.test/*")
  const site = { id: "site", action: "audit", kind: "network", target: "https://example.test/*" }
  assert.equal(matchingRules(site, [site], [redacted])[0].uncertain, false)
  const path = { ...site, id: "path", target: "https://example.test/private" }
  assert.equal(matchingRules(path, [path], [redacted])[0].uncertain, true)
  assert.equal(matchingRules(site, [path, site], [redacted])[0].uncertain, true)
  assert.deepEqual(
    matchingRules({ ...site, target: "https://other.test/*" }, [site], [redacted]),
    [],
  )
  const shell = { ...entry, kind: "process", operation: "exec", target: "node" }
  assert.equal(needsTarget(shell), true)
  assert.equal("target" in eventRule(shell), false)
  const command = { id: "shell", kind: "process", target: "node *", action: "deny" }
  assert.equal(matchingRules(command, [command], [shell])[0].uncertain, true)
})
