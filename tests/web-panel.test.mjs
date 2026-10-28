import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { GuardPanel } from "../dist/web/server.js"
import { savePanelSettings } from "../dist/web/panel-settings.js"
import { parseSettings } from "../dist/config/index.js"
import { SettingsController } from "../dist/host/settings.js"
import { AlertService } from "../dist/host/alerts.js"

async function fixture(t, configure, panelSettings = {}, controllers) {
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const root = fs.mkdtempSync(path.join(temporaryRoot, "guard-web-panel-"))
  const stateDir = path.join(root, "data/yunzai-guard")
  fs.mkdirSync(stateDir, { recursive: true })
  const plugin = path.join(root, "plugins/demo-plugin")
  fs.mkdirSync(plugin, { recursive: true })
  fs.writeFileSync(path.join(plugin, "package.json"), '{"description":"面板验证夹具"}')
  fs.writeFileSync(path.join(stateDir, "host.log"), "[INFO] fixture ready\n")
  const settings = parseSettings({
    rules: [{ id: "demo-rule", plugin: "demo-plugin", action: "audit" }],
  })
  const configuration = configure?.(settings)
  fs.writeFileSync(path.join(stateDir, "settings.json"), JSON.stringify(settings))
  const now = Date.now()
  fs.writeFileSync(
    path.join(stateDir, "events.jsonl"),
    [
      {
        type: "audit",
        time: now,
        sequence: 1,
        hostPid: process.pid,
        generation: 1,
        event: {
          plugin: "demo-plugin",
          kind: "network",
          operation: "fetch",
          target: "https://example.test/",
          action: "audit",
          details: { token: "fixture-private" },
        },
      },
      {
        type: "audit",
        time: now + 1,
        sequence: 2,
        hostPid: process.pid,
        generation: 1,
        event: {
          plugin: "demo-plugin",
          kind: "process",
          operation: "exec",
          target: "example",
          action: "deny",
        },
      },
    ]
      .map(item => JSON.stringify(item))
      .join("\n") + "\n",
  )
  const probe = net.createServer()
  await new Promise((resolve, reject) => {
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", resolve)
  })
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  savePanelSettings(stateDir, { host: "127.0.0.1", port })
  if (Object.keys(panelSettings).length) {
    const file = path.join(stateDir, "panel.json")
    fs.writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ...panelSettings }),
    )
  }
  let restarts = 0
  let panel
  const start = async () => {
    panel = new GuardPanel({
      root,
      stateDir,
      settings,
      ...(configuration
        ? {
            getSettings: () => configuration.active,
            configuration: () => configuration.state,
            applySettings: next => configuration.request(next),
          }
        : {}),
      version: "test",
      ...(controllers ? { controllers } : {}),
      status: () => ({ phase: "online", generation: 1 }),
      restart: () => restarts++,
      resume() {},
    })
    assert.equal(await panel.start(), true)
  }
  await start()
  t.after(async () => {
    await panel.stop()
    assert.equal(path.dirname(root), temporaryRoot)
    fs.rmSync(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${port}`
  async function request(route, { cookie, csrf, method = "GET", body, headers = {} } = {}) {
    const response = await fetch(base + route, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: {
        Connection: "close",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(csrf ? { "x-guard-csrf": csrf } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const raw = await response.text()
    return { status: response.status, headers: response.headers, body: JSON.parse(raw) }
  }
  async function login(remember = false) {
    assert.equal(
      (await request("/api/login/code/request", { method: "POST", body: {} })).status,
      200,
    )
    const code = fs.readFileSync(path.join(stateDir, "login-code.txt"), "utf8").trim()
    const result = await request("/api/login/code/check", {
      method: "POST",
      body: { code, remember },
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/156.0.0.0 Safari/537.36",
      },
    })
    assert.equal(result.status, 200)
    return {
      response: result,
      cookie: result.headers.get("set-cookie").split(";")[0],
      csrf: result.body.csrfToken,
    }
  }
  return {
    root,
    stateDir,
    settings,
    configuration,
    base,
    request,
    login,
    restarts: () => restarts,
    panel: () => panel,
    restart: async () => {
      await panel.stop()
      await start()
    },
  }
}

test(
  "配置应用状态反映真实活动快照，失败后可重试且面板会话保持有效",
  { timeout: 15000 },
  async t => {
    let release
    let rejectReload = false
    const app = await fixture(
      t,
      settings =>
        new SettingsController(settings, {
          prepare: async () => undefined,
          applyLive() {},
          reload: async () => {
            if (rejectReload) throw new Error("fixture reload failed")
            await new Promise(resolve => {
              release = resolve
            })
          },
        }),
    )
    const session = await app.login(true)
    const current = await app.request("/api/settings", session)
    const next = {
      ...current.body.document,
      rules: [{ id: "next", action: "deny", kind: "process" }],
    }
    const save = async document => {
      const latest = await app.request("/api/settings", session)
      return app.request("/api/settings", {
        ...session,
        method: "PUT",
        body: { document, revision: latest.body.revision },
      })
    }
    assert.equal((await save(next)).body.apply.status, "applying")
    const applying = app.configuration.applyPending()
    await new Promise(resolve => setImmediate(resolve))
    let overview = (await app.request("/api/overview", session)).body
    assert.equal(overview.apply.status, "applying")
    assert.equal(overview.active.rules[0].id, "demo-rule")
    release()
    await applying
    overview = (await app.request("/api/overview", session)).body
    assert.equal(overview.apply.status, "applied")
    assert.equal(overview.active.rules[0].id, "next")
    assert.equal(overview.pendingRestart, false)
    rejectReload = true
    const failed = { ...next, rules: [] }
    await save(failed)
    await app.configuration.applyPending()
    assert.equal((await app.request("/api/settings", session)).body.apply.status, "failed")
    assert.equal((await save(failed)).body.apply.status, "applying")
    rejectReload = false
    const retry = app.configuration.applyPending()
    await new Promise(resolve => setImmediate(resolve))
    release()
    await retry
    assert.equal((await app.request("/api/settings", session)).body.active.rules.length, 0)
    assert.equal((await app.request("/api/session", session)).status, 200)
    assert.equal(app.restarts(), 0)
  },
)

test("HTTP 登录使用安全会话，拒绝跨源、缺失 CSRF 和 URL 令牌", { timeout: 15000 }, async t => {
  const app = await fixture(t)
  const session = await app.login(true)
  const cookie = session.response.headers.get("set-cookie")
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
  assert.match(cookie, /Max-Age=\d+/)
  assert.equal("token" in session.response.body, false)
  const info = await app.request("/api/session", session)
  assert.equal(info.body.remembered, true)
  assert.equal(info.body.csrfToken, session.csrf)
  const urlToken = session.cookie.split("=")[1]
  assert.equal((await app.request(`/api/session?token=${urlToken}`)).status, 401)
  assert.equal(
    (
      await app.request("/api/actions/restart", {
        cookie: session.cookie,
        method: "POST",
        body: {},
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await app.request("/api/actions/restart", {
        ...session,
        method: "POST",
        body: {},
        headers: { Origin: "https://other.example" },
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await app.request("/api/actions/restart", {
        ...session,
        method: "POST",
        body: {},
        headers: { Origin: app.base },
      })
    ).status,
    200,
  )
  assert.equal(app.restarts(), 1)
  const temporary = await app.login()
  assert.equal(temporary.response.headers.get("set-cookie").includes("Max-Age="), false)
  const index = await fetch(app.base + "/")
  assert.equal(index.status, 200)
  const html = await index.text()
  const script = html.match(/src="(\/assets\/[^\"]+\.js)"/)[1]
  const asset = await fetch(app.base + script)
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get("content-type"), /javascript/)
  await asset.text()
  for (const route of ["/src/main.tsx", "/lib/api.js", "/.vite/manifest.json"])
    assert.equal((await fetch(app.base + route)).status, 404)
  const traversal = await fetch(app.base + "/lib/../../package.json")
  assert.equal(traversal.status, 404)
  await traversal.text()
})

test("HTTP 结构化审计和插件汇总可读，配置保存拒绝旧版本覆盖", { timeout: 15000 }, async t => {
  const app = await fixture(t)
  const session = await app.login()
  const audit = await app.request("/api/audit?plugin=demo-plugin&action=deny", session)
  assert.equal(audit.status, 200)
  assert.equal(audit.body.items.length, 1)
  assert.equal(audit.body.items[0].operation, "exec")
  assert.equal(audit.body.coverage.complete, false)
  const all = await app.request("/api/audit", session)
  assert.equal(JSON.stringify(all.body).includes("fixture-private"), false)
  const plugins = await app.request("/api/plugins", session)
  const plugin = plugins.body.plugins.find(item => item.id === "demo-plugin")
  assert.equal(plugin.stats.total, 2)
  assert.equal(plugin.stats.deny, 1)
  const current = await app.request("/api/settings", session)
  assert.deepEqual(
    (await app.request("/api/overview", session)).body.defaults.protectTargets,
    parseSettings({}).protect.targets,
  )
  const document = { ...current.body.document, startupTimeout: 61000 }
  const update = { ...session, method: "PUT", body: { document, revision: current.body.revision } }
  const saved = await app.request("/api/settings", update)
  assert.equal(saved.status, 200)
  assert.equal(saved.body.pendingRestart, true)
  assert.equal((await app.request("/api/settings", update)).status, 409)
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(app.stateDir, "settings.json"))).startupTimeout,
    61000,
  )
  const legacy = { strictJs: { timeoutMs: 1400, plugins: [] } }
  fs.writeFileSync(path.join(app.stateDir, "settings.json"), JSON.stringify(legacy))
  const compatible = await app.request("/api/settings", session)
  assert.deepEqual(compatible.body.document, legacy)
  assert.equal(compatible.body.normalized.pluginSandbox.timeoutMs, 1400)
  assert.equal("strictJs" in compatible.body.normalized, false)
  assert.equal(
    (
      await app.request("/api/settings", {
        ...session,
        method: "PUT",
        body: { document: compatible.body.normalized, revision: compatible.body.revision },
      })
    ).status,
    200,
  )
  fs.appendFileSync(
    path.join(app.stateDir, "events.jsonl"),
    JSON.stringify({
      type: "audit",
      time: Date.now(),
      sequence: 3,
      event: {
        plugin: "demo-plugin",
        kind: "network",
        operation: "  =1+1",
        target: "https://example.test/",
        action: "audit",
      },
    }) + "\n",
  )
  const exported = await fetch(app.base + "/api/audit/export?format=csv", {
    headers: { Cookie: session.cookie, Connection: "close" },
  })
  assert.equal(exported.status, 200)
  assert.ok((await exported.text()).includes("'  =1+1"))
})

test("可信设备跨面板重启续用，撤销同时终止 API 与日志会话", { timeout: 15000 }, async t => {
  const app = await fixture(t)
  const session = await app.login(true)
  await app.restart()
  const info = await app.request("/api/session", session)
  assert.equal(info.status, 200)
  assert.equal(info.body.csrfToken, session.csrf)
  const list = await app.request("/api/security/sessions", session)
  const device = list.body.sessions.find(item => item.current)
  assert.equal(device.remembered, true)
  assert.equal(device.name, "Chrome · Windows")
  const stream = await fetch(app.base + "/api/logs/stream", {
    headers: { Cookie: session.cookie },
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(stream.status, 200)
  assert.match(stream.headers.get("content-type"), /event-stream/)
  const reader = stream.body.getReader()
  try {
    assert.equal((await reader.read()).done, false)
    const revoked = await app.request(`/api/security/sessions/${device.id}`, {
      ...session,
      method: "DELETE",
      body: {},
    })
    assert.equal(revoked.status, 200)
    assert.equal(revoked.body.revoked, true)
    assert.equal((await app.request("/api/session", session)).status, 401)
    assert.equal((await reader.read()).done, true)
  } finally {
    await reader.cancel()
  }
})

test("备份恢复与规则导入拒绝旧配置版本，不把无效规则转换为全局放行规则", async t => {
  const app = await fixture(t)
  const session = await app.login()
  const before = (await app.request("/api/settings", session)).body
  const document = { ...before.document, startupTimeout: 61000 }
  assert.equal(
    (
      await app.request("/api/settings", {
        ...session,
        method: "PUT",
        body: { document, revision: before.revision },
      })
    ).status,
    200,
  )
  const backup = (await app.request("/api/settings/backups", session)).body.backups[0]
  assert.ok(backup)
  const current = (await app.request("/api/settings", session)).body
  const rules = [{ id: "imported-rule", kind: "process", action: "deny" }]
  for (const [route, body] of [
    ["restore", { id: backup.id }],
    ["import-rules", { rules, mode: "replace" }],
  ])
    assert.equal(
      (
        await app.request(`/api/settings/${route}`, {
          ...session,
          method: "POST",
          body: { ...body, revision: before.revision },
        })
      ).status,
      409,
    )
  assert.equal(
    (
      await app.request("/api/settings/import-rules", {
        ...session,
        method: "POST",
        body: { rules: [null], mode: "replace", revision: current.revision },
      })
    ).status,
    400,
  )
  assert.deepEqual((await app.request("/api/settings", session)).body.document, document)
  assert.equal(
    (
      await app.request("/api/settings/import-rules", {
        ...session,
        method: "POST",
        body: { rules, mode: "replace", revision: current.revision },
      })
    ).status,
    200,
  )
  const imported = (await app.request("/api/settings", session)).body
  assert.deepEqual(imported.document.rules, rules)
  assert.equal(
    (
      await app.request("/api/settings/restore", {
        ...session,
        method: "POST",
        body: { id: backup.id, revision: imported.revision },
      })
    ).status,
    200,
  )
  assert.equal(
    (await app.request("/api/settings", session)).body.document.startupTimeout,
    before.document.startupTimeout,
  )
})

test("分块请求体超限返回 413 JSON，后续面板请求仍可正常使用", async t => {
  const app = await fixture(t)
  const result = await new Promise((resolve, reject) => {
    const request = http.request(
      app.base + "/api/login/code/check",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
      },
      response => {
        let text = ""
        response.setEncoding("utf8")
        response.on("data", chunk => (text += chunk))
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(text) }))
        response.on("error", reject)
      },
    )
    request.on("error", reject)
    for (let index = 0; index < 17; index++) request.write("x".repeat(64 * 1024))
    request.end()
  })
  assert.equal(result.status, 413)
  assert.equal(typeof result.body.error, "string")
  assert.equal((await app.request("/api/meta")).status, 200)
})

test("面板保存值与实际监听地址分开，只有地址变更需要重启", { timeout: 15000 }, async t => {
  const app = await fixture(t)
  const session = await app.login()
  const current = (await app.request("/api/overview", session)).body.panel
  const update = body => app.request("/api/panel", { ...session, method: "POST", body })
  assert.equal((await update({ tokenTtlHours: 12 })).body.restartRequired, false)
  const port = current.port === 65535 ? 65534 : current.port + 1
  assert.equal((await update({ host: "localhost", port })).body.restartRequired, true)
  const saved = (await app.request("/api/overview", session)).body.panel
  assert.equal(saved.host, "localhost")
  assert.equal(saved.port, port)
  assert.equal(saved.listener.host, current.host)
  assert.equal(saved.listener.port, current.port)
  assert.equal(saved.restartRequired, true)
  assert.equal((await app.request("/api/session", session)).status, 200)
  assert.equal(
    (await update({ host: current.host, port: current.port })).body.restartRequired,
    false,
  )
})

async function logStream(app, session) {
  const response = await fetch(app.base + "/api/logs/stream", {
    headers: { Cookie: session.cookie },
    signal: AbortSignal.timeout(10000),
  })
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  return {
    async next() {
      for (;;) {
        const end = pending.indexOf("\n\n")
        if (end >= 0) {
          const frame = pending.slice(0, end)
          pending = pending.slice(end + 2)
          if (frame.startsWith("data: ")) return JSON.parse(frame.slice(6))
          continue
        }
        const chunk = await reader.read()
        if (chunk.done) throw new Error("日志连接已关闭")
        pending += decoder.decode(chunk.value, { stream: true })
      }
    },
    close: () => reader.cancel().catch(() => {}),
  }
}

test("日志流在截断、同尺寸轮转与超限后重置视图", { timeout: 10000 }, async t => {
  const app = await fixture(t)
  const stream = await logStream(app, await app.login())
  const file = path.join(app.stateDir, "host.log")
  try {
    assert.deepEqual(await stream.next(), { text: "[INFO] fixture ready\n" })
    fs.appendFileSync(file, "[INFO] appended\n")
    assert.deepEqual(await stream.next(), { append: "[INFO] appended\n" })
    fs.writeFileSync(file, "short\n")
    assert.deepEqual(await stream.next(), { text: "short\n" })
    fs.renameSync(file, file + ".1")
    fs.writeFileSync(file, "equal\n")
    assert.deepEqual(await stream.next(), { text: "equal\n" })
    fs.truncateSync(file, 0)
    assert.deepEqual(await stream.next(), { text: "" })
    fs.appendFileSync(file, "prefix" + "x".repeat(256 * 1024))
    assert.deepEqual(await stream.next(), { text: "x".repeat(256 * 1024) })
  } finally {
    await stream.close()
  }
})

test("日志慢连接暂停推送并在背压超时后断开", { timeout: 12000 }, async t => {
  const app = await fixture(t)
  const original = http.ServerResponse.prototype.write
  let response
  let writes = 0
  t.mock.method(http.ServerResponse.prototype, "write", function (...args) {
    const result = Reflect.apply(original, this, args)
    if (this.req.url === "/api/logs/stream") {
      response = this
      writes++
      return false
    }
    return result
  })
  const stream = await logStream(app, await app.login())
  try {
    await stream.next()
    fs.appendFileSync(path.join(app.stateDir, "host.log"), "paused\n")
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal(writes, 1)
    response.emit("drain")
    assert.deepEqual(await stream.next(), { append: "paused\n" })
    assert.equal(writes, 2)
    await assert.rejects(stream.next())
    assert.equal(response.destroyed, true)
  } finally {
    await stream.close()
  }
})

test("同机反向代理转发时按真实客户端限速，不因一人失败锁住所有人", { timeout: 15000 }, async t => {
  const app = await fixture(t, undefined, { trustProxy: true, allowExternal: true })
  assert.equal(
    (await app.request("/api/login/code/request", { method: "POST", body: {} })).status,
    200,
  )
  const code = fs.readFileSync(path.join(app.stateDir, "login-code.txt"), "utf8").trim()
  const attempt = (value, client) =>
    app.request("/api/login/code/check", {
      method: "POST",
      body: { code: value },
      headers: { "X-Forwarded-For": `198.51.100.1, ${client}` },
    })
  for (let index = 0; index < 8; index++)
    assert.equal((await attempt("WRONG", "203.0.113.7")).status, 401)
  assert.equal((await attempt(code, "203.0.113.7")).status, 429)
  assert.equal((await attempt(code, "203.0.113.8")).status, 200)
})

test("默认忽略伪造代理头，启用代理时非法地址仍受连接地址限速", { timeout: 15000 }, async t => {
  for (const trustProxy of [false, true]) {
    const app = await fixture(t, undefined, { trustProxy, allowExternal: true })
    for (let index = 0; index < 9; index++) {
      const address = trustProxy ? `203.0.113.${256 + index}` : `203.0.113.${index}`
      const result = await app.request("/api/login/code/check", {
        method: "POST",
        body: { code: "WRONG" },
        headers: { "X-Forwarded-For": address },
      })
      assert.equal(result.status, index < 8 ? 401 : 429)
    }
  }
})

test("默认拒绝局域网以外的来源，开启外网访问后放行", { timeout: 15000 }, async t => {
  const denied = await fixture(t, undefined, { trustProxy: true })
  const headers = { "X-Forwarded-For": "203.0.113.50" }
  const blocked = await denied.request("/api/meta", { headers })
  assert.equal(blocked.status, 403)
  assert.equal(
    (await denied.request("/api/meta", { headers: { "X-Forwarded-For": "192.168.1.9" } })).status,
    200,
  )
  const open = await fixture(t, undefined, { trustProxy: true, allowExternal: true })
  assert.equal((await open.request("/api/meta", { headers })).status, 200)
})

test("告警已读与静默、资源曲线和审计对比接口可用", { timeout: 15000 }, async t => {
  let alerts
  const points = [{ time: 1, rssBytes: 1024, cpu: 0.2, hostRssBytes: 2048, hostLagMs: 1 }]
  const controllers = {
    get alerts() {
      return {
        history: limit => alerts.history(limit),
        testWebhook: async () => ({ ok: true }),
        state: () => alerts.state(),
        acknowledge: ids => alerts.acknowledge(ids),
        mute: (target, minutes) => alerts.mute(target, minutes),
        unmute: key => alerts.unmute(key),
        raise: (...args) => alerts.raise(...args),
      }
    },
    resources: { points: () => points },
    profiles: {},
    sources: {},
  }
  const app = await fixture(t, undefined, {}, controllers)
  alerts = new AlertService({
    settings: () => app.settings,
    stateDir: app.stateDir,
    projectId: "test",
    send: () => true,
    record() {},
  })
  alerts.raise("deny", "一条", "【Yunzai Guard】拦截", { key: "k", plugin: "demo-plugin" })
  const auth = await app.login()
  const call = (route, body, method = body === undefined ? "GET" : "POST") =>
    app.request(route, { cookie: auth.cookie, csrf: auth.csrf, method, body })

  const resources = await call("/api/resources")
  assert.equal(resources.status, 200)
  assert.deepEqual(resources.body.points, points)
  assert.ok(resources.body.system.totalMemory > 0)

  const [first] = (await call("/api/alerts")).body.history
  assert.ok(first.id)
  const ack = await call("/api/alerts/ack", { ids: [first.id] })
  assert.deepEqual(ack.body.state.read, [first.id])

  const muted = await call("/api/alerts/mute", { plugin: "demo-plugin", minutes: 30 })
  assert.equal(muted.body.state.mutes[0].key, "plugin:demo-plugin")
  assert.equal((await call("/api/alerts/mute", { minutes: 30 })).status, 400)
  assert.equal((await call("/api/alerts/mute", { plugin: "x", minutes: 0 })).status, 400)
  const cleared = await call("/api/alerts/unmute", { key: "plugin:demo-plugin" })
  assert.deepEqual(cleared.body.state.mutes, [])

  const now = Date.now()
  const compare = await call(
    `/api/audit/compare?aFrom=1&aTo=${now - 100000}&bFrom=${now - 99999}&bTo=${now + 10000}&plugin=demo-plugin`,
  )
  assert.equal(compare.status, 200)
  assert.equal(compare.body.b.total, 2)
  assert.equal(compare.body.b.blocked, 1)
  assert.equal(compare.body.added.length, 2)
  assert.equal((await call("/api/audit/compare?aFrom=1")).status, 400)
})

test("聊天登录链接经地址片段一次性换取会话，可按配置关闭", { timeout: 15000 }, async t => {
  const app = await fixture(t, undefined, { publicUrl: "https://guard.example.com/" })
  const { urls, ttlSeconds } = app.panel().loginLink()
  assert.equal(ttlSeconds, 300)
  assert.equal(urls.length, 1)
  const match = /^https:\/\/guard\.example\.com\/#login=([A-Za-z0-9_-]{43})$/.exec(urls[0])
  assert.ok(match, urls[0])
  const origin = { Origin: app.base }
  const wrong = await app.request("/api/login/link", {
    method: "POST",
    body: { token: "x".repeat(43) },
    headers: origin,
  })
  assert.equal(wrong.status, 401)
  const result = await app.request("/api/login/link", {
    method: "POST",
    body: { token: match[1] },
    headers: origin,
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.remembered, false)
  const cookie = result.headers.get("set-cookie").split(";")[0]
  assert.equal((await app.request("/api/session", { cookie })).status, 200)
  const reused = await app.request("/api/login/link", {
    method: "POST",
    body: { token: match[1] },
    headers: origin,
  })
  assert.equal(reused.status, 401)
  const session = await app.login()
  const saved = await app.request("/api/panel", {
    ...session,
    method: "POST",
    body: { chatLogin: false },
  })
  assert.equal(saved.status, 200)
  assert.throws(() => app.panel().loginLink(), { status: 403 })
})
