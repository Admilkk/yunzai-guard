import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"

const repository = fileURLToPath(new URL("../", import.meta.url))
const temporaryRoot = fs.realpathSync(os.tmpdir())

function fixtureDirectory(t) {
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "guard-demo-test-"))
  t.after(() => {
    const resolved = fs.realpathSync(directory)
    assert.equal(path.dirname(resolved), temporaryRoot)
    assert.ok(path.basename(resolved).startsWith("guard-demo-test-"))
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  return directory
}

async function launch(t, directory, args = []) {
  const readyFile = path.join(directory, `ready-${Date.now()}.json`)
  const child = spawn(
    process.execPath,
    ["scripts/demo-panel.mjs", "--ready-file", readyFile, ...args],
    {
      cwd: repository,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  )
  let output = ""
  child.stdout.on("data", chunk => {
    output += chunk
  })
  child.stderr.on("data", chunk => {
    output += chunk
  })
  const exited = new Promise(resolve => child.once("exit", resolve))
  const stop = async () => {
    if (child.exitCode !== null) return
    child.stdin.write("stop\n")
    const timer = setTimeout(() => child.kill(), 5000)
    const code = await exited
    clearTimeout(timer)
    assert.equal(code, 0, output)
  }
  t.after(stop)
  const deadline = Date.now() + 20000
  while (!fs.existsSync(readyFile) && child.exitCode === null && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 60))
  assert.ok(fs.existsSync(readyFile), output || "demo startup timeout")
  const ready = JSON.parse(fs.readFileSync(readyFile, "utf8"))
  const token = new URL(ready.loginUrl).hash.slice("#login=".length)
  const login = await fetch(`${ready.baseUrl}/api/login/link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(login.status, 200)
  const session = await login.json()
  const headers = {
    Cookie: login.headers.get("set-cookie").split(";")[0],
    "x-guard-csrf": session.csrfToken,
    "Content-Type": "application/json",
    Connection: "close",
  }
  async function request(route, body) {
    const response = await fetch(`${ready.baseUrl}${route}`, {
      headers,
      method: body === undefined ? "GET" : "PUT",
      signal: AbortSignal.timeout(5000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  return { ready, readyFile, request, stop }
}

async function settled(app) {
  const deadline = Date.now() + 8000
  let current
  do {
    current = await app.request("/api/settings")
    if (current.apply.status !== "applying") return current
    await new Promise(resolve => setTimeout(resolve, 60))
  } while (Date.now() < deadline)
  throw new Error("demo apply timeout")
}

test(
  "独立 demo 使用示例数据，批量保存只重启一次，退出清理临时目录",
  { timeout: 30000 },
  async t => {
    const directory = fixtureDirectory(t)
    const app = await launch(t, directory)
    assert.equal(new URL(app.ready.baseUrl).hostname, "127.0.0.1")
    assert.equal(path.dirname(app.ready.root), temporaryRoot)
    const overview = await app.request("/api/overview")
    assert.match(overview.version, /-demo$/)
    assert.equal(overview.plugins.length, 4)
    assert.equal(overview.status.demo.workerRestarts, 0)
    const audit = await app.request("/api/audit?action=deny&pageSize=100")
    assert.ok(audit.total >= 30)
    assert.ok(audit.items.some(entry => entry.plugin === "unknown"))
    const current = await app.request("/api/settings")
    const document = current.normalized
    for (const host of ["api.example.test", "images.example.test"])
      document.rules.unshift({
        id: `demo.test.${host}`,
        plugin: "miao-plugin",
        kind: "network",
        action: "audit",
        target: `https://${host}/*`,
      })
    await app.request("/api/settings", {
      title: "批量放行示例站点",
      document,
      revision: current.revision,
    })
    assert.equal((await settled(app)).apply.status, "applied")
    assert.equal((await app.request("/api/overview")).status.demo.workerRestarts, 1)
    await app.stop()
    assert.equal(fs.existsSync(app.ready.root), false)
    assert.equal(fs.existsSync(app.readyFile), false)
  },
)

test("demo 支持启动故障和应用失败场景，失败配置可重试", { timeout: 30000 }, async t => {
  const directory = fixtureDirectory(t)
  const startup = await launch(t, directory, ["--scenario", "startup"])
  assert.equal((await startup.request("/api/overview")).status.phase, "tripped")
  await startup.stop()
  const failed = await launch(t, directory, ["--scenario", "apply-failure"])
  const current = await failed.request("/api/settings")
  assert.equal(current.apply.status, "failed")
  await failed.request("/api/settings", {
    title: "重试示例配置",
    document: current.normalized,
    revision: current.revision,
  })
  assert.equal((await settled(failed)).apply.status, "applied")
  const status = (await failed.request("/api/overview")).status
  assert.equal(status.demo.applyAttempts, 2)
  assert.equal(status.demo.workerRestarts, 1)
  await failed.stop()
})

test("demo 持久目录保留修改，拒绝写入未标记的非空目录", { timeout: 30000 }, async t => {
  const directory = fixtureDirectory(t)
  const persistent = path.join(directory, "persistent")
  const first = await launch(t, directory, ["--persist-dir", persistent])
  const current = await first.request("/api/settings")
  current.normalized.alerts.enabled = false
  await first.request("/api/settings", { document: current.normalized, revision: current.revision })
  await settled(first)
  await first.stop()
  assert.equal(fs.existsSync(persistent), true)
  const second = await launch(t, directory, ["--persist-dir", persistent])
  assert.equal((await second.request("/api/settings")).normalized.alerts.enabled, false)
  await second.stop()
  const child = spawn(process.execPath, ["scripts/demo-panel.mjs", "--persist-dir", directory], {
    cwd: repository,
    windowsHide: true,
    stdio: "ignore",
  })
  assert.equal(await new Promise(resolve => child.once("exit", resolve)), 1)
  assert.equal(fs.existsSync(path.join(persistent, "data/yunzai-guard/settings.yaml")), true)
})
