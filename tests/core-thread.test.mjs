import assert from "node:assert/strict"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { CoreHost } from "../dist/host/core.js"
import { savePanelSettings } from "../dist/web/panel-settings.js"
import { parseSettings } from "../dist/config/index.js"

const pluginDir = fileURLToPath(new URL("../", import.meta.url))

async function freePort() {
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve))
  const { port } = probe.address()
  await new Promise(resolve => probe.close(resolve))
  return port
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "guard-core-"))
  const stateDir = path.join(root, "data/yunzai-guard")
  fs.mkdirSync(stateDir, { recursive: true })
  const port = await freePort()
  savePanelSettings(stateDir, { host: "127.0.0.1", port })
  const settings = parseSettings({})
  const calls = []
  let checks = 0
  const handlers = {
    getSettings: () => settings,
    configuration: () => ({ status: "applied", mode: "live", liveFields: [], reloadFields: [] }),
    applySettings: () => ({ status: "applied" }),
    status: () => {
      calls.push("status")
      return { phase: "online", generation: 7, hostPid: process.pid }
    },
    "update.state": () => ({ current: "1.0.0", phase: "idle" }),
    "update.check": async () => {
      checks++
      await new Promise(resolve => setTimeout(resolve, 50))
      return { current: "1.0.0", checked: checks }
    },
    "update.apply": () => ({ ok: true, message: "ok" }),
    "update.rollback": () => ({ ok: false, message: "none" }),
    "update.applyPending": () => ({ ok: false, message: "none" }),
    "alerts.history": () => [],
    "alerts.state": () => ({ readBefore: 0, read: [], mutes: [] }),
    "alerts.raise": (...args) => calls.push(["raise", args[0]]),
    "resources.points": () => [],
    audit: type => calls.push(["audit", type]),
    restart: () => calls.push("restart"),
    resume: () => calls.push("resume"),
  }
  const records = []
  const core = new CoreHost({
    stateDir,
    root,
    settings: () => settings,
    handlers,
    record: (type, details) => records.push({ type, ...details }),
  })
  t.after(async () => {
    await core.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${port}`
  async function login() {
    await fetch(`${base}/api/login/code/request`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: "{}",
    })
    const code = fs.readFileSync(path.join(stateDir, "login-code.txt"), "utf8").trim()
    const response = await fetch(`${base}/api/login/code/check`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    return {
      Cookie: response.headers.get("set-cookie").split(";")[0],
      "x-guard-csrf": body.csrfToken,
      Origin: base,
    }
  }
  return { core, base, calls, records, login, root }
}

test("控制台在线程中运行，同步与异步调用都转发到宿主", { timeout: 30000 }, async t => {
  const app = await fixture(t)
  assert.equal(await app.core.start(pluginDir), true)
  assert.equal(app.core.pluginDir, pluginDir)
  assert.match(app.core.version, /^\d+\.\d+\.\d+/)
  const headers = await app.login()
  const overview = await (await fetch(`${app.base}/api/overview`, { headers })).json()
  assert.equal(overview.status.generation, 7)
  assert.ok(app.calls.includes("status"))
  assert.ok(app.calls.some(item => Array.isArray(item) && item[0] === "audit"))
  const checked = await fetch(`${app.base}/api/update/check`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: "{}",
  })
  assert.equal((await checked.json()).checked, 1)
  const { urls, ttlSeconds } = await app.core.loginLink()
  assert.equal(ttlSeconds, 300)
  assert.match(urls[0], /#login=[A-Za-z0-9_-]{43}$/)
})

test("换线程后会话保留；新线程无法启动时回到原目录", { timeout: 30000 }, async t => {
  const app = await fixture(t)
  assert.equal(await app.core.start(pluginDir), true)
  const headers = await app.login()
  assert.equal(await app.core.swap(pluginDir), true)
  const session = await fetch(`${app.base}/api/session`, { headers })
  assert.equal(session.status, 200)
  const broken = path.join(app.root, "broken-plugin")
  fs.mkdirSync(path.join(broken, "dist/web"), { recursive: true })
  fs.writeFileSync(path.join(broken, "dist/web/thread.js"), "throw new Error('broken core')\n")
  assert.equal(await app.core.swap(broken), false)
  assert.equal(app.core.pluginDir, pluginDir)
  assert.equal((await fetch(`${app.base}/api/session`, { headers })).status, 200)
  assert.ok(app.records.some(item => item.type === "core-start-failed"))
  await app.core.stop()
  await assert.rejects(app.core.loginLink(), /控制台未启用/)
})
