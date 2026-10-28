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
  const panel = () => ({
    root,
    stateDir,
    settings,
    getSettings: () => settings,
    configuration: () => ({ status: "applied", mode: "live", liveFields: [], reloadFields: [] }),
    applySettings: () => ({ status: "applied" }),
    status: () => {
      calls.push("status")
      return { phase: "online", generation: 7, hostPid: process.pid }
    },
    update: {
      state: () => ({ current: "1.0.0", phase: "idle" }),
      check: async () => ({ current: "1.0.0", checked: ++checks }),
      apply: async () => ({ ok: true, message: "ok" }),
      rollback: async () => ({ ok: false, message: "none" }),
      applyPending: async () => ({ ok: false, message: "none" }),
    },
    restart: () => calls.push("restart"),
    resume: () => calls.push("resume"),
    audit: type => calls.push(["audit", type]),
  })
  const records = []
  const core = new CoreHost({
    panel,
    record: (type, details) => records.push({ type, ...details }),
  })
  t.after(async () => {
    await core.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${port}`
  async function login() {
    const headers = { Origin: base, "Content-Type": "application/json", Connection: "close" }
    await fetch(`${base}/api/login/code/request`, { method: "POST", headers, body: "{}" })
    const code = fs.readFileSync(path.join(stateDir, "login-code.txt"), "utf8").trim()
    const response = await fetch(`${base}/api/login/code/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({ code }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    return {
      Cookie: response.headers.get("set-cookie").split(";")[0],
      "x-guard-csrf": body.csrfToken,
      Origin: base,
      // 控制台重新加载时会关闭旧连接，测试请求不复用长连接。
      Connection: "close",
    }
  }
  return { core, base, calls, records, login, root }
}

/** 造一个控制台入口异常的插件目录。 */
function brokenPlugin(root, name, source) {
  const directory = path.join(root, name)
  fs.mkdirSync(path.join(directory, "dist/web"), { recursive: true })
  fs.writeFileSync(path.join(directory, "dist/web/index.js"), source)
  return directory
}

test("控制台在宿主内运行并直接使用宿主能力", { timeout: 30000 }, async t => {
  const app = await fixture(t)
  assert.equal(await app.core.start(pluginDir), true)
  assert.equal(app.core.pluginDir, pluginDir)
  assert.match(app.core.version, /^\d+\.\d+\.\d+/)
  const headers = await app.login()
  const overview = await (await fetch(`${app.base}/api/overview`, { headers })).json()
  assert.equal(overview.status.generation, 7)
  assert.match(overview.version, /^\d+\.\d+\.\d+/)
  assert.ok(app.calls.includes("status"))
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

test("重新加载控制台后会话保留；无法启动的控制台回到原目录", { timeout: 30000 }, async t => {
  const app = await fixture(t)
  assert.equal(await app.core.start(pluginDir), true)
  const headers = await app.login()
  // 第二次加载使用新代号，得到独立的模块实例。
  assert.equal(await app.core.swap(pluginDir), true)
  assert.equal(await app.core.swap(pluginDir), true)
  assert.deepEqual(
    app.records.filter(item => item.type === "core-started").map(item => item.generation),
    [0, 1, 2],
  )
  assert.equal((await fetch(`${app.base}/api/session`, { headers })).status, 200)

  const throwing = brokenPlugin(app.root, "broken", "throw new Error('broken core')\n")
  assert.equal(await app.core.swap(throwing), false)
  const mismatched = brokenPlugin(
    app.root,
    "mismatched",
    "export const coreProtocol = 999\nexport const startPanel = async () => true\n",
  )
  assert.equal(await app.core.swap(mismatched), false)
  assert.equal(app.core.pluginDir, pluginDir)
  assert.equal((await fetch(`${app.base}/api/session`, { headers })).status, 200)
  const failures = app.records.filter(item => item.type === "core-start-failed")
  assert.match(failures[0].message, /broken core/)
  assert.match(failures[1].message, /protocol 999/)
  await app.core.stop()
  await assert.rejects(app.core.loginLink(), /控制台未启用/)
})
