import assert from "node:assert/strict"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { parseSettings } from "../dist/config/index.js"
import { renderSettings } from "../dist/config/settings-file.js"
import { GuardPanel } from "../dist/web/server.js"
import { savePanelSettings } from "../dist/web/panel-settings.js"
import { readTaskCases, acknowledgeTaskCases, diagnosePlugin } from "../dist/web/task-cases.js"

const deny = { id: "network-deny", kind: "network", action: "deny" }

function fixture(t, rules = [deny], rows = []) {
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const root = fs.mkdtempSync(path.join(temporaryRoot, "guard-web-tasks-"))
  const stateDir = path.join(root, "data/yunzai-guard")
  fs.mkdirSync(stateDir, { recursive: true })
  const settings = parseSettings({ rules })
  fs.writeFileSync(path.join(stateDir, "settings.yaml"), renderSettings(settings))
  let sequence = 0
  const append = records => {
    fs.appendFileSync(
      path.join(stateDir, "events.jsonl"),
      records
        .map(event =>
          JSON.stringify({
            type: "audit",
            time: Date.now() + ++sequence,
            sequence,
            hostPid: 42,
            generation: 1,
            event: {
              plugin: "alpha",
              kind: "network",
              operation: "fetch",
              target: "https://one.test/",
              action: "deny",
              ruleId: deny.id,
              ...event,
            },
          }),
        )
        .join("\n") + (records.length ? "\n" : ""),
    )
  }
  append(rows)
  t.after(() => {
    assert.equal(path.dirname(root), temporaryRoot)
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, stateDir, settings, append }
}

test("待办按插件、行为、目标与历史规则分组，数量仅计读取样本", t => {
  const app = fixture(
    t,
    [deny],
    [
      {},
      {},
      { target: "https://two.test/" },
      { operation: "http.get" },
      { ruleId: "older-rule" },
      { plugin: "beta" },
    ],
  )
  const result = readTaskCases(app.stateDir, app.settings)
  assert.equal(result.cases.length, 5)
  assert.deepEqual(result.cases.map(item => item.count).sort(), [1, 1, 1, 1, 2])
  assert.equal(result.coverage.sampled, 6)
  assert.equal(result.coverage.complete, false)
  assert.equal(
    result.cases.every(item => /^[a-f0-9]{64}$/.test(item.id) && item.currentRuleId === deny.id),
    true,
  )
})

test("保持拦截持久化且不改权限或审计；新目标或配置上下文重新提示", t => {
  const app = fixture(t, [deny], [{}])
  const first = readTaskCases(app.stateDir, app.settings).cases[0]
  const originalSettings = fs.readFileSync(path.join(app.stateDir, "settings.yaml"), "utf8")
  const originalAudit = fs.readFileSync(path.join(app.stateDir, "events.jsonl"), "utf8")
  assert.deepEqual(acknowledgeTaskCases(app.stateDir, app.settings, [first.id]).cases, [])
  assert.deepEqual(readTaskCases(app.stateDir, app.settings).cases, [])
  assert.equal(
    readTaskCases(app.stateDir, app.settings, { includeAcknowledged: true }).cases[0].acknowledged,
    true,
  )
  assert.equal(fs.readFileSync(path.join(app.stateDir, "settings.yaml"), "utf8"), originalSettings)
  assert.equal(fs.readFileSync(path.join(app.stateDir, "events.jsonl"), "utf8"), originalAudit)
  const persisted = JSON.parse(
    fs.readFileSync(path.join(app.stateDir, "panel-task-state.json"), "utf8"),
  )
  assert.equal(persisted.items[0].id, first.id)
  assert.equal(JSON.stringify(persisted).includes("one.test"), false)
  app.append([{}])
  assert.deepEqual(readTaskCases(app.stateDir, app.settings).cases, [])
  app.append([{ target: "https://new.test/" }])
  assert.equal(readTaskCases(app.stateDir, app.settings).cases[0].target, "https://new.test/")
  const changed = parseSettings({ rules: [{ ...deny, id: "new-rule" }] })
  fs.writeFileSync(path.join(app.stateDir, "settings.yaml"), renderSettings(changed))
  const reopened = readTaskCases(app.stateDir, changed)
  assert.equal(reopened.cases.length, 2)
  assert.equal(
    reopened.cases.every(item => item.id !== first.id && !item.acknowledged),
    true,
  )
  assert.equal(acknowledgeTaskCases(app.stateDir, changed, [first.id]), undefined)
})

test("已放行的历史事件退出待办，脱敏不确定保留，自保护固定拒绝不被过滤", t => {
  const app = fixture(t, [deny], [{ target: "https://one.test/private" }])
  const site = {
    id: "site",
    plugin: "alpha",
    kind: "network",
    target: "https://one.test/*",
    action: "audit",
  }
  const pathRule = { ...site, id: "path", target: "https://one.test/private" }
  const uncertain = readTaskCases(app.stateDir, parseSettings({ rules: [pathRule, deny] }))
  assert.equal(uncertain.cases.length, 1)
  assert.equal(uncertain.cases[0].uncertain, true)
  assert.deepEqual(readTaskCases(app.stateDir, parseSettings({ rules: [site, deny] })).cases, [])
  app.append([
    {
      kind: "self-protection",
      operation: "guard.write",
      target: "data/yunzai-guard/settings.yaml",
      ruleId: undefined,
    },
  ])
  const fixed = readTaskCases(app.stateDir, parseSettings({ rules: [] }))
  assert.equal(fixed.cases.length, 1)
  assert.equal(fixed.cases[0].kind, "self-protection")
  assert.equal(fixed.cases[0].currentAction, "deny")
})

test("显式拒绝的脚本保留待办与诊断，移除限制后退出待办", t => {
  const app = fixture(
    t,
    [{ id: "deny-script", kind: "process", target: "node", action: "deny" }],
    [
      {
        kind: "process",
        operation: "spawn",
        target: "node",
        ruleId: undefined,
        details: { scriptExecution: true, argumentsRedacted: true, blocked: true },
      },
      {
        kind: "process",
        operation: "spawn",
        target: "ordinary-command",
        ruleId: undefined,
      },
    ],
  )
  const result = readTaskCases(app.stateDir, app.settings)
  assert.equal(result.cases.length, 1)
  assert.equal(result.cases[0].target, "node")
  assert.equal(result.cases[0].currentAction, "deny")
  assert.equal(result.cases[0].currentRuleId, "deny-script")
  assert.equal(result.cases[0].uncertain, false)
  assert.equal(diagnosePlugin(app.stateDir, app.settings, "alpha").findings[0].kind, "blocked")
  const allowed = parseSettings({
    rules: [
      { id: "allow-node", kind: "process", plugin: "alpha", target: "node", action: "audit" },
    ],
  })
  fs.writeFileSync(path.join(app.stateDir, "settings.yaml"), renderSettings(allowed))
  assert.deepEqual(readTaskCases(app.stateDir, allowed).cases, [])
})

test("原生清理固定重启不会被观察规则隐藏，普通 Hook 仍按规则放行", t => {
  const rules = [{ id: "observe-sandbox", kind: "plugin-sandbox", action: "audit" }]
  const app = fixture(
    t,
    rules,
    [
      "native.cleanup-unconfirmed",
      "native.registration-cleanup-unconfirmed",
      "native.adapter-cleanup-unconfirmed",
      "native.hook",
    ].map(operation => ({
      kind: "plugin-sandbox",
      operation,
      target: "alpha",
      action: "restart",
      ruleId: undefined,
    })),
  )
  const settings = parseSettings({
    rules,
    pluginSandbox: { native: { plugins: [{ id: "alpha", adapters: true }] } },
  })
  const result = readTaskCases(app.stateDir, settings)
  assert.deepEqual(result.cases.map(item => item.operation).sort(), [
    "native.adapter-cleanup-unconfirmed",
    "native.cleanup-unconfirmed",
    "native.registration-cleanup-unconfirmed",
  ])
  assert.equal(
    result.cases.every(item => item.currentAction === "restart"),
    true,
  )
  const diagnosis = diagnosePlugin(app.stateDir, settings, "alpha")
  assert.equal(diagnosis.findings[0].kind, "blocked")
  assert.equal(diagnosis.cases.length, 3)
  const disabledAdapters = parseSettings({
    rules,
    pluginSandbox: { native: { plugins: [{ id: "alpha", adapters: false }] } },
  })
  assert.equal(readTaskCases(app.stateDir, disabledAdapters).cases.length, 2)
})

test("待办采样上限不伪装全量数量，损坏状态不会隐藏待办", t => {
  const app = fixture(
    t,
    [deny],
    Array.from({ length: 520 }, () => ({})),
  )
  const result = readTaskCases(app.stateDir, app.settings)
  assert.equal(result.cases[0].count, 500)
  assert.equal(result.coverage.sampled, 500)
  assert.equal(result.coverage.matched, 520)
  assert.equal(result.coverage.truncated, true)
  fs.writeFileSync(path.join(app.stateDir, "panel-task-state.json"), "{bad")
  const damaged = readTaskCases(app.stateDir, app.settings)
  assert.equal(damaged.cases.length, 1)
  assert.deepEqual(damaged.coverage.errors, ["待办状态读取失败"])
})

test("诊断只列关联审计和全局结构化错误，不把日志文本当作插件归因", t => {
  const app = fixture(t, [deny], [{}])
  fs.writeFileSync(
    path.join(app.stateDir, "host.log"),
    "[ERROR] beta caused all failures EADDRINUSE\n",
  )
  const unknown = diagnosePlugin(app.stateDir, app.settings, "beta", undefined, {
    phase: "online",
    workerPid: 123,
  })
  assert.deepEqual(
    unknown.findings.map(item => item.kind),
    ["unknown"],
  )
  const diagnosed = diagnosePlugin(app.stateDir, app.settings, "alpha")
  assert.equal(diagnosed.findings[0].kind, "blocked")
  assert.equal(diagnosed.findings[0].scope, "plugin")
  assert.equal(diagnosed.findings[0].evidence.length, 1)
  const apply = {
    status: "failed",
    mode: "worker-reload",
    revision: 1,
    liveFields: [],
    reloadFields: ["rules"],
    restartFields: [],
    error: "bad config password=fixture-secret",
  }
  const global = diagnosePlugin(app.stateDir, app.settings, "beta", apply, {
    phase: "tripped",
    trippedReason: "failure token=fixture-secret",
  })
  assert.deepEqual(
    global.findings.map(item => [item.kind, item.scope]),
    [
      ["unknown", "plugin"],
      ["configuration", "global"],
      ["startup", "global"],
    ],
  )
  assert.equal(JSON.stringify(global).includes("fixture-secret"), false)
})

test("待办与诊断接口要求登录，确认要求 CSRF 和当前配置版本", async t => {
  const app = fixture(t, [deny], [{}])
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  savePanelSettings(app.stateDir, { host: "127.0.0.1", port })
  const panel = new GuardPanel({
    root: app.root,
    stateDir: app.stateDir,
    settings: app.settings,
    version: "test",
    status: () => ({ phase: "online" }),
    restart() {},
    resume() {},
  })
  await panel.start()
  t.after(async () => await panel.stop())
  const base = `http://127.0.0.1:${port}`
  const call = async (route, options = {}) => {
    const response = await fetch(base + route, {
      ...options,
      headers: { Connection: "close", ...(options.headers ?? {}) },
    })
    return { status: response.status, headers: response.headers, body: await response.json() }
  }
  assert.equal((await call("/api/tasks")).status, 401)
  assert.equal((await call("/api/plugins/diagnose?plugin=alpha")).status, 401)
  const token = new URL(panel.loginLink().urls[0]).hash.slice("#login=".length)
  const login = await call("/api/login/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  })
  assert.equal(login.status, 200)
  const cookie = login.headers.get("set-cookie").split(";")[0]
  const headers = { Cookie: cookie, "Content-Type": "application/json" }
  const current = await call("/api/tasks", { headers })
  assert.equal(current.status, 200)
  const body = JSON.stringify({ ids: [current.body.cases[0].id], revision: current.body.revision })
  assert.equal((await call("/api/tasks/ack", { method: "POST", headers, body })).status, 403)
  headers["x-guard-csrf"] = login.body.csrfToken
  assert.equal(
    (
      await call("/api/tasks/ack", {
        method: "POST",
        headers,
        body: JSON.stringify({ ids: [current.body.cases[0].id], revision: "old" }),
      })
    ).status,
    409,
  )
  const acknowledged = await call("/api/tasks/ack", { method: "POST", headers, body })
  assert.equal(acknowledged.status, 200)
  assert.deepEqual(acknowledged.body.cases, [])
  assert.deepEqual((await call("/api/tasks", { headers })).body.cases, [])
  const diagnosed = await call("/api/plugins/diagnose?plugin=alpha", { headers })
  assert.equal(diagnosed.status, 200)
  assert.equal(diagnosed.body.findings[0].kind, "blocked")
  assert.equal((await call("/api/plugins/diagnose", { headers })).status, 400)
})
