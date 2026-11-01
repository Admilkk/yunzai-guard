import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import ts from "typescript"
import { parse } from "yaml"
import { decide } from "../dist/config/policy.js"

function compile(file, replacements = []) {
  let source = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  for (const [from, to] of replacements)
    source = source.replaceAll(JSON.stringify(from), JSON.stringify(to))
  return "data:text/javascript;base64," + Buffer.from(source).toString("base64")
}
const policy = new URL("../dist/config/policy.js", import.meta.url).href
const shared = [
  ["../../../src/config/policy.js", policy],
  [
    "../../../src/config/sample-policy.js",
    new URL("../dist/config/sample-policy.js", import.meta.url).href,
  ],
]
const rulesUrl = compile("../web/src/lib/rules.ts", shared)
const draftUrl = compile("../web/src/lib/draft-actions.ts", [
  ...shared,
  ["yaml", import.meta.resolve("yaml")],
])
const quickUrl = compile("../web/src/lib/quick-actions.ts", [
  ...shared,
  ["./rules", rulesUrl],
  ["./policy.js", new URL("../web/src/lib/policy.js", import.meta.url).href],
])
const { rulesOverlap, draftConflicts, resetConflictingRules, mergeRawRules } = await import(
  draftUrl
)
const { applyCaseChoices } = await import(
  compile("../web/src/lib/case-actions.ts", [
    ["./rules", rulesUrl],
    ["./draft-actions", draftUrl],
    ["./quick-actions", quickUrl],
    ["../api", compile("../web/src/api.ts")],
  ])
)
const broad = { id: "network", kind: "network", action: "deny" }
const specific = {
  id: "specific",
  plugin: "alpha",
  kind: "network",
  operation: "fetch",
  target: "https://one.test/*",
  action: "deny",
}
const makeCase = (id, overrides = {}) => {
  const entry = {
    id,
    time: 1,
    type: "audit",
    plugin: "alpha",
    kind: "network",
    operation: "fetch",
    target: "https://one.test/",
    action: "deny",
    ruleId: "network",
    details: {},
    ...overrides,
  }
  return {
    id,
    ...entry,
    currentAction: "deny",
    currentRuleId: "network",
    count: 1,
    lastAt: 1,
    entry,
    uncertain: false,
    acknowledged: false,
  }
}
const event = (overrides = {}) => ({
  plugin: "alpha",
  kind: "network",
  operation: "fetch",
  target: "https://one.test/",
  ...overrides,
})

test("不同站点或互斥前后缀的通配规则不会误报冲突", () => {
  const scoped = target => ({
    id: target,
    plugin: "alpha",
    kind: "network",
    operation: "fetch",
    target,
    action: "audit",
  })
  assert.equal(rulesOverlap(scoped("https://api.test/*"), scoped("https://images.test/*")), false)
  assert.equal(
    rulesOverlap(scoped("https://api.test/images/*"), scoped("https://api.test/videos/*")),
    false,
  )
  assert.equal(
    rulesOverlap(scoped("https://api.test/*.png"), scoped("https://api.test/*.json")),
    false,
  )
  assert.equal(rulesOverlap(scoped("https://*.test/*"), scoped("https://api.test/*")), true)
  const base = { rules: [broad] }
  const draft = { rules: [scoped("https://api.test/*"), broad] }
  const next = { rules: [scoped("https://images.test/*"), ...draft.rules] }
  assert.deepEqual(draftConflicts(base, draft, next), [])
})

test("草稿冲突只包含重叠规则，接受本次操作保留其他规则及字段", () => {
  const unrelated = { ...specific, id: "other-plugin", plugin: "beta", action: "audit" }
  const base = { rules: [specific, broad], alerts: { enabled: true }, startupTimeout: 60000 }
  const draft = {
    ...structuredClone(base),
    rules: [{ ...specific, action: "audit" }, unrelated, broad],
    alerts: { enabled: false },
    startupTimeout: 70000,
  }
  const next = structuredClone(draft)
  next.rules.unshift({ ...specific, id: "quick", action: "deny" })
  const conflicts = draftConflicts(base, draft, next)
  assert.deepEqual(
    conflicts.map(rule => rule.id),
    ["specific"],
  )
  const reset = resetConflictingRules(base, draft, conflicts)
  assert.equal(reset.rules.find(rule => rule.id === "specific").action, "deny")
  assert.deepEqual(
    reset.rules.find(rule => rule.id === "other-plugin"),
    unrelated,
  )
  assert.deepEqual(reset.alerts, { enabled: false })
  assert.equal(reset.startupTimeout, 70000)
  assert.equal(draft.rules[0].action, "audit")
  assert.equal(rulesOverlap(specific, unrelated), false)
})

for (const edit of ["add", "change", "remove"])
  test(`排序同时${edit}其他规则仍会报告优先级冲突`, () => {
    const fallback = { id: "fallback", kind: "network", action: "audit" }
    const unrelated = { ...specific, id: "beta", plugin: "beta" }
    const base = { rules: [specific, fallback, ...(edit === "add" ? [] : [unrelated])] }
    const draft = {
      rules: [
        fallback,
        specific,
        ...(edit === "remove" ? [] : [{ ...unrelated, action: "audit" }]),
      ],
    }
    const next = { rules: [{ ...specific, id: "quick" }, ...draft.rules] }
    assert.deepEqual(
      draftConflicts(base, draft, next).map(rule => rule.id),
      ["fallback", "specific"],
    )
  })

test("插入或删除规则不改变共同规则顺序时，不误报优先级冲突", () => {
  const fallback = { id: "fallback", kind: "network", action: "audit" }
  const unrelated = { ...specific, id: "beta-old", plugin: "beta" }
  const base = { rules: [specific, unrelated, fallback] }
  const draft = { rules: [{ ...unrelated, id: "beta-new" }, specific, fallback] }
  const next = { rules: [{ ...specific, id: "quick" }, ...draft.rules] }
  assert.deepEqual(draftConflicts(base, draft, next), [])
})

test("替换排序冲突恢复原优先级，并保留不冲突草稿规则的相对顺序", () => {
  const fallback = { id: "fallback", kind: "network", action: "audit" }
  const unrelated = { ...specific, id: "beta", plugin: "beta" }
  const added = { ...unrelated, id: "beta-new", action: "audit" }
  const base = { rules: [specific, fallback, unrelated] }
  const draft = {
    rules: [fallback, unrelated, specific, added],
    alerts: { enabled: false },
  }
  const next = { rules: [{ ...specific, id: "quick" }, ...draft.rules] }
  const conflicts = draftConflicts(base, draft, next)
  const restored = resetConflictingRules(base, draft, conflicts)
  assert.deepEqual(
    restored.rules.map(rule => rule.id),
    ["specific", "fallback", "beta", "beta-new"],
  )
  assert.equal(decide(event(), restored.rules).action, "deny")
  assert.deepEqual(restored.alerts, draft.alerts)
  assert.deepEqual(
    draft.rules.map(rule => rule.id),
    ["fallback", "beta", "specific", "beta-new"],
  )
})

test("恢复被删除的冲突规则保留原匹配优先级", () => {
  const fallback = { id: "fallback", kind: "network", action: "audit" }
  const base = { rules: [specific, fallback] }
  const draft = { rules: [fallback], alerts: { enabled: false } }
  const restored = resetConflictingRules(base, draft, [specific])
  assert.deepEqual(
    restored.rules.map(rule => rule.id),
    ["specific", "fallback"],
  )
  assert.equal(decide(event(), restored.rules).action, "deny")
  assert.deepEqual(restored.alerts, { enabled: false })
})

test("合并原始 YAML 只更新规则，保留注释、其他草稿字段及所选顺序", () => {
  const raw = `# settings note\nalerts:\n  # alert note\n  enabled: false\nstartupTimeout: 70000\nrules:\n  # specific note\n  - id: specific\n    plugin: alpha\n    kind: network\n    action: deny # action note\n  # fallback note\n  - id: fallback\n    kind: network\n    action: audit\n`
  const before = parse(raw)
  const changed = mergeRawRules(raw, [
    before.rules[1],
    { ...before.rules[0], action: "audit" },
    { id: "new", plugin: "beta", kind: "network", action: "deny" },
  ])
  const after = parse(changed)
  assert.deepEqual(
    after.rules.map(rule => rule.id),
    ["fallback", "specific", "new"],
  )
  assert.equal(after.rules[1].action, "audit")
  assert.deepEqual(after.alerts, { enabled: false })
  assert.equal(after.startupTimeout, 70000)
  for (const note of [
    "settings note",
    "alert note",
    "specific note",
    "action note",
    "fallback note",
  ])
    assert.equal(changed.includes(note), true, note)
  assert.throws(() => mergeRawRules("rules: [\n", []))
})

test("空白原始 YAML 可加入快捷规则", () => {
  const rules = [specific, broad]
  const merged = mergeRawRules(" \n\n", rules)
  assert.deepEqual(parse(merged), { rules })
  assert.deepEqual(
    parse(merged).rules.map(rule => rule.id),
    ["specific", "network"],
  )
})

test("仅注释的原始 YAML 加入规则后保留文件头注释", () => {
  const merged = mergeRawRules("# settings header\n# user note\n", [specific])
  assert.deepEqual(parse(merged), { rules: [specific] })
  assert.ok(merged.indexOf("# settings header") >= 0)
  assert.ok(merged.indexOf("# user note") >= 0)
  assert.ok(merged.indexOf("# settings header") < merged.indexOf("rules:"))
  assert.ok(merged.indexOf("# user note") < merged.indexOf("rules:"))
})

test("批量相同站点范围的相反动作在修改前拒绝", () => {
  const first = makeCase("one", { target: "https://one.test/[path-redacted]" })
  const second = makeCase("two", {
    target: "https://one.test/[path-redacted]",
    ruleId: "older-rule",
  })
  const document = { rules: [broad], alerts: { enabled: false } }
  const before = structuredClone(document)
  assert.throws(
    () =>
      applyCaseChoices(document, [
        { item: first, action: "audit" },
        { item: second, action: "deny" },
      ]),
    /冲突/,
  )
  assert.deepEqual(document, before)
})

test("多个目标生成一份配置，同范围相同动作去重且不改其他权限", () => {
  const first = makeCase("one", { target: "https://one.test/[path-redacted]" })
  const duplicate = makeCase("again", {
    target: "https://one.test/[path-redacted]",
    ruleId: "old-rule",
  })
  const second = makeCase("two", { target: "https://two.test/[path-redacted]" })
  const document = { rules: [broad], alerts: { enabled: false } }
  applyCaseChoices(
    document,
    [first, duplicate, second].map(item => ({ item, action: "audit" })),
  )
  assert.equal(document.rules.length, 3)
  assert.equal(decide(event({ target: "https://one.test/path" }), document.rules).action, "audit")
  assert.equal(decide(event({ target: "https://two.test/path" }), document.rules).action, "audit")
  assert.equal(decide(event({ plugin: "beta" }), document.rules).action, "deny")
  assert.equal(decide(event({ target: "https://other.test/" }), document.rules).action, "deny")
  assert.deepEqual(document.alerts, { enabled: false })
})

test("保持现状不改配置，未知来源放行在整个批次修改前拒绝", () => {
  const document = { rules: [broad], alerts: { enabled: false } }
  const before = structuredClone(document)
  applyCaseChoices(document, [{ item: makeCase("keep"), action: "keep" }])
  assert.deepEqual(document, before)
  const unknown = makeCase("unknown", { plugin: "unknown", target: "https://two.test/" })
  assert.throws(
    () =>
      applyCaseChoices(document, [
        { item: makeCase("valid"), action: "audit" },
        { item: unknown, action: "audit" },
      ]),
    /来源/,
  )
  assert.deepEqual(document, before)
})
