import assert from "node:assert/strict"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { parseSettings } from "../dist/config/index.js"
import { renderSettings } from "../dist/config/settings-file.js"
import { SettingsController } from "../dist/host/settings.js"
import { GuardPanel } from "../dist/web/server.js"
import { savePanelSettings } from "../dist/web/panel-settings.js"

async function fixture(t) {
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const root = fs.mkdtempSync(path.join(temporaryRoot, "guard-settings-plan-"))
  const stateDir = path.join(root, "data/yunzai-guard")
  fs.mkdirSync(stateDir, { recursive: true })
  const initial = parseSettings({})
  const file = path.join(stateDir, "settings.yaml")
  fs.writeFileSync(file, renderSettings(initial))
  const controller = new SettingsController(initial, {
    prepare: async () => {},
    applyLive() {},
    reload: async () => {},
  })
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  savePanelSettings(stateDir, { host: "127.0.0.1", port })
  const panel = new GuardPanel({
    root,
    stateDir,
    settings: initial,
    version: "test",
    getSettings: () => controller.active,
    configuration: () => controller.state,
    applySettings: next => controller.request(next),
    status: () => ({ phase: "online" }),
    restart() {},
    resume() {},
  })
  assert.equal(await panel.start(), true)
  t.after(async () => {
    await panel.stop()
    assert.equal(path.dirname(fs.realpathSync(root)), temporaryRoot)
    assert.ok(path.basename(root).startsWith("guard-settings-plan-"))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${port}`
  const token = new URL(panel.loginLink().urls[0]).hash.slice("#login=".length)
  const login = await fetch(`${base}/api/login/link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify({ token }),
  })
  assert.equal(login.status, 200)
  const session = await login.json()
  const headers = {
    Cookie: login.headers.get("set-cookie").split(";")[0],
    "x-guard-csrf": session.csrfToken,
    "Content-Type": "application/json",
    Connection: "close",
  }
  const request = async (route, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(base + route, {
      method,
      headers,
      signal: AbortSignal.timeout(5000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }
  return { stateDir, file, initial, controller, request }
}

test("普通保存拒绝预览后的生效计划漂移，不写配置、备份或操作记录", async t => {
  const app = await fixture(t)
  const current = (await app.request("/api/settings")).body
  const pending = {
    ...current.normalized,
    rules: [{ id: "pending", kind: "network", action: "deny" }],
  }
  const saved = await app.request(
    "/api/settings",
    { document: pending, revision: current.revision },
    "PUT",
  )
  assert.equal(saved.status, 200)
  const candidate = structuredClone(app.initial)
  const preview = (await app.request("/api/settings/validate", { document: candidate })).body
  assert.deepEqual(preview.plan.reloadFields, [])
  assert.match(preview.planRevision, /^[a-f0-9]{64}$/)
  const beforeText = fs.readFileSync(app.file, "utf8")
  const historyFile = path.join(app.stateDir, "settings-operations.json")
  const beforeHistory = fs.readFileSync(historyFile, "utf8")
  const backupsBefore = fs.readdirSync(path.join(app.stateDir, "settings-history"))
  await app.controller.applyPending()
  const stale = await app.request(
    "/api/settings",
    { document: candidate, revision: saved.body.revision, planRevision: preview.planRevision },
    "PUT",
  )
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error, "生效方式已变更，请重新确认")
  assert.equal(fs.readFileSync(app.file, "utf8"), beforeText)
  assert.equal(fs.readFileSync(historyFile, "utf8"), beforeHistory)
  assert.deepEqual(fs.readdirSync(path.join(app.stateDir, "settings-history")), backupsBefore)
  const fresh = (await app.request("/api/settings/validate", { document: candidate })).body
  assert.deepEqual(fresh.plan.reloadFields, ["rules"])
  assert.notEqual(fresh.planRevision, preview.planRevision)
  const accepted = await app.request(
    "/api/settings",
    { document: candidate, revision: saved.body.revision, planRevision: fresh.planRevision },
    "PUT",
  )
  assert.equal(accepted.status, 200)
  await app.controller.applyPending()
  assert.deepEqual(app.controller.active.rules, [])
})

test("生效计划摘要按规范配置比较，兼容 YAML 与未携带摘要的 API 保存", async t => {
  const app = await fixture(t)
  const current = (await app.request("/api/settings")).body
  const document = {
    ...current.normalized,
    alerts: { ...current.normalized.alerts, enabled: false },
  }
  const raw = "# raw plan comparison\n" + renderSettings(document)
  const structured = (await app.request("/api/settings/validate", { document })).body
  const yaml = (await app.request("/api/settings/validate", { raw })).body
  assert.equal(structured.planRevision, yaml.planRevision)
  assert.equal(
    (
      await app.request(
        "/api/settings",
        { raw, revision: current.revision, planRevision: structured.planRevision },
        "PUT",
      )
    ).status,
    200,
  )
  assert.equal(fs.readFileSync(app.file, "utf8"), raw)
  await app.controller.applyPending()
  const next = (await app.request("/api/settings")).body
  assert.equal(
    (
      await app.request(
        "/api/settings",
        { document: current.normalized, revision: next.revision },
        "PUT",
      )
    ).status,
    200,
  )
  const unchanged = fs.readFileSync(app.file, "utf8")
  const latest = (await app.request("/api/settings")).body
  assert.equal(
    (
      await app.request(
        "/api/settings",
        { document, revision: latest.revision, planRevision: null },
        "PUT",
      )
    ).status,
    409,
  )
  assert.equal(fs.readFileSync(app.file, "utf8"), unchanged)
})
