import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import ts from "typescript"

function compile(file, replacements = []) {
  let code = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  for (const [from, to] of replacements) code = code.replaceAll(from, to)
  return "data:text/javascript;base64," + Buffer.from(code).toString("base64")
}
const policy = new URL("../dist/config/policy.js", import.meta.url).href
const sample = new URL("../dist/config/sample-policy.js", import.meta.url).href
const rules = compile("../web/src/lib/rules.ts", [
  ["../../../src/config/policy.js", policy],
  ["../../../src/config/sample-policy.js", sample],
])
const quick = compile("../web/src/lib/quick-actions.ts", [
  ["../../../src/config/policy.js", policy],
  ["./rules", rules],
  ["./policy.js", new URL("../web/src/lib/policy.js", import.meta.url).href],
])
const draft = compile("../web/src/lib/draft-actions.ts", [
  ["../../../src/config/policy.js", policy],
  ["yaml", new URL("../node_modules/yaml/browser/index.js", import.meta.url).href],
])
const api = compile("../web/src/api.ts")
const { acknowledgeCases, acknowledgeCasesAfterApply } = await import(
  compile("../web/src/lib/case-actions.ts", [
    ["./quick-actions", quick],
    ["./rules", rules],
    ["./draft-actions", draft],
    ["../api", api],
  ])
)

const original = {
  id: "old-context",
  plugin: "demo",
  kind: "network",
  operation: "fetch",
  target: "https://example.test/[path-redacted]",
  ruleId: "network",
  currentRuleId: "network",
  action: "deny",
  currentAction: "deny",
  uncertain: false,
  count: 1,
  lastAt: 1,
  acknowledged: false,
  entry: {},
}
const current = { ...original, id: "after-authorized-save" }
const settings = (status = "applied", revision = "committed", applyRevision = 2) => ({
  revision,
  apply: { status, revision: applyRevision },
})
const tasks = (cases = [current], revision = "committed") => ({ revision, cases })

function transport(t, steps, options = {}) {
  const requests = []
  const nativeTimeout = globalThis.setTimeout
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    if (delay === 500 || (options.timeout && delay === 15000)) {
      queueMicrotask(() => callback(...args))
      return 0
    }
    return nativeTimeout(callback, delay, ...args)
  })
  t.mock.method(globalThis, "fetch", async (route, options = {}) => {
    const next = steps.shift()
    assert.ok(next, `Unexpected request: ${route}`)
    const method = options.method ?? "GET"
    const body = options.body ? JSON.parse(options.body) : undefined
    requests.push({ route, method, body })
    if (next.error) throw next.error
    assert.equal(route, next.route)
    assert.equal(method, next.method ?? "GET")
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    })
  })
  return requests
}

test("单项核对仅提交用户看到的旧 id 与 revision，不迁移到新配置上下文", async t => {
  const requests = transport(t, [
    { route: "/api/tasks/ack", method: "POST", status: 409, body: { error: "待办已变更" } },
  ])
  await assert.rejects(
    acknowledgeCases([original], "observed-revision"),
    error => error.status === 409,
  )
  assert.deepEqual(requests, [
    {
      route: "/api/tasks/ack",
      method: "POST",
      body: { ids: [original.id], revision: "observed-revision" },
    },
  ])
})

test("混合批量等本次配置实际生效，再核对同版本与应用代次并确认 keep 项", async t => {
  const requests = transport(t, [
    { route: "/api/settings", body: settings("applying") },
    { route: "/api/settings", body: settings() },
    { route: "/api/tasks", body: tasks() },
    { route: "/api/settings", body: settings() },
    { route: "/api/tasks/ack", method: "POST" },
  ])
  assert.equal(await acknowledgeCasesAfterApply([original], "committed"), true)
  assert.deepEqual(requests.at(-1).body, { ids: [current.id], revision: "committed" })
  assert.equal(requests.filter(item => item.method === "POST").length, 1)
})

for (const status of ["failed", "pending-restart", "unknown"])
  test(`应用状态 ${status} 不会确认新上下文`, async t => {
    const requests = transport(t, [{ route: "/api/settings", body: settings(status) }])
    assert.equal(await acknowledgeCasesAfterApply([original], "committed"), false)
    assert.equal(requests.length, 1)
  })

test("应用前或待办读取后出现外部保存，不确认任何新上下文", async t => {
  for (const steps of [
    [{ route: "/api/settings", body: settings("applied", "external") }],
    [
      { route: "/api/settings", body: settings() },
      { route: "/api/tasks", body: tasks([current], "external") },
    ],
    [
      { route: "/api/settings", body: settings() },
      { route: "/api/tasks", body: tasks() },
      { route: "/api/settings", body: settings("applied", "external") },
    ],
    [
      { route: "/api/settings", body: settings() },
      { route: "/api/tasks", body: tasks() },
      { route: "/api/settings", body: settings("applying") },
    ],
    [
      { route: "/api/settings", body: settings() },
      { route: "/api/tasks", body: tasks() },
      { route: "/api/settings", body: settings("applied", "committed", 3) },
    ],
  ])
    await t.test("拒绝变化中的上下文", async t => {
      const requests = transport(t, steps)
      assert.equal(await acknowledgeCasesAfterApply([original], "committed"), false)
      assert.equal(
        requests.some(item => item.method === "POST"),
        false,
      )
    })
})

test("同版本中的命中规则或动作已变化时保留待办", async t => {
  const requests = transport(t, [
    { route: "/api/settings", body: settings() },
    { route: "/api/tasks", body: tasks([{ ...current, currentRuleId: "another-rule" }]) },
  ])
  assert.equal(await acknowledgeCasesAfterApply([original], "committed"), false)
  assert.equal(
    requests.some(item => item.method === "POST"),
    false,
  )
})

test("核对提交的 409 返回未完成；网络和其他服务错误仍向调用方报告", async t => {
  await t.test("POST 409", async t => {
    transport(t, [
      { route: "/api/settings", body: settings() },
      { route: "/api/tasks", body: tasks() },
      { route: "/api/settings", body: settings() },
      { route: "/api/tasks/ack", method: "POST", status: 409, body: { error: "待办已变更" } },
    ])
    assert.equal(await acknowledgeCasesAfterApply([original], "committed"), false)
  })
  await t.test("HTTP 500", async t => {
    transport(t, [{ route: "/api/settings", status: 500, body: { error: "读取失败" } }])
    await assert.rejects(acknowledgeCasesAfterApply([original], "committed"), /读取失败/)
  })
  await t.test("网络错误", async t => {
    transport(t, [{ route: "/api/settings", error: new Error("offline") }])
    await assert.rejects(acknowledgeCasesAfterApply([original], "committed"), /offline/)
  })
})

test("15 秒截止会终止等待，不产生确认请求", async t => {
  const requests = transport(t, [{ route: "/api/settings", body: settings("applying") }], {
    timeout: true,
  })
  assert.equal(await acknowledgeCasesAfterApply([original], "committed"), false)
  assert.equal(requests.filter(item => item.method === "POST").length, 0)
})

test("部分 keep 项缺失时只确认仍匹配的项，并返回未全部完成", async t => {
  const other = { ...original, id: "other", target: "https://another.test/" }
  const requests = transport(t, [
    { route: "/api/settings", body: settings() },
    { route: "/api/tasks", body: tasks() },
    { route: "/api/settings", body: settings() },
    { route: "/api/tasks/ack", method: "POST" },
  ])
  assert.equal(await acknowledgeCasesAfterApply([original, other], "committed"), false)
  assert.deepEqual(requests.at(-1).body.ids, [current.id])
})
