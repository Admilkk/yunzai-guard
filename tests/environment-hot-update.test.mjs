import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"

// 端到端验证热更新编排：用 CLI 还原到预置的“上一版本”，避免依赖 GitHub 发布。
// 插件文件复制到临时目录运行，更新只改动副本。
const repository = fileURLToPath(new URL("../", import.meta.url))
const environmentOptions = { skip: !["win32", "linux"].includes(process.platform), timeout: 180000 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha256 = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")

async function until(predicate, message, timeout = 60000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function freePort() {
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve))
  const { port } = probe.address()
  await new Promise(resolve => probe.close(resolve))
  return port
}

async function fixture(t, settings = {}, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "guard-hot-update-"))
  const plugin = path.join(root, "plugins", "yunzai-guard")
  for (const item of ["index.js", "dist", "native", "package.json"])
    fs.cpSync(path.join(repository, item), path.join(plugin, item), { recursive: true })
  const state = path.join(root, "data", "yunzai-guard")
  fs.mkdirSync(state, { recursive: true })
  const port = await freePort()
  fs.writeFileSync(
    path.join(state, "panel.json"),
    JSON.stringify({ host: "127.0.0.1", port, jwtSecret: "s".repeat(48) }),
  )
  fs.writeFileSync(
    path.join(state, "settings.json"),
    JSON.stringify({ shutdownTimeout: 3000, startupTimeout: 20000, ...settings }),
  )
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}')
  fs.writeFileSync(
    path.join(root, "app.js"),
    `
import fs from "node:fs"
import { EventEmitter } from "node:events"
const bot = new EventEmitter()
bot.em = () => {}
bot.prepareEvent = () => {}
bot.exitEvent = async () => {}
bot.redisExit = async () => {}
globalThis.Bot = bot
setTimeout(() => {
  fs.writeFileSync("online.json", JSON.stringify({ pid: process.pid }))
  bot.emit("online")
}, 100)
setInterval(() => {}, 1000)
`,
  )
  const env = { ...process.env, ...extraEnv }
  for (const key of ["NODE_OPTIONS", "pm_id", "PM2_HOME", "NODE_APP_INSTANCE"]) delete env[key]
  const child = spawn(process.execPath, [path.join(plugin, "dist", "launcher.js")], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  let stderr = ""
  child.stdout.resume()
  child.stderr.on("data", chunk => {
    stderr = (stderr + chunk).slice(-16000)
  })
  const exited = once(child, "exit")
  void exited.catch(() => {})
  const cli = (...args) =>
    JSON.parse(
      execFileSync(process.execPath, [path.join(plugin, "dist", "cli.js"), ...args], {
        cwd: root,
        env,
        encoding: "utf8",
        windowsHide: true,
      }),
    )
  const status = () => {
    try {
      return cli("status")
    } catch {
      return undefined
    }
  }
  t.after(async () => {
    try {
      cli("stop")
    } catch {}
    // 宿主可能已自行重启，不再是本测试的子进程：等控制端点消失再清理目录。
    // 清理未确认而熔断的宿主会按设计拒绝退出并持有项目锁，此时强制结束。
    const last = status()
    await until(() => !status(), "host did not stop", 20000).catch(() => {
      if (last?.hostPid) process.kill(last.hostPid, "SIGKILL")
    })
    await sleep(500)
    await Promise.race([exited, sleep(15000)])
    if (child.exitCode === null) child.kill("SIGKILL")
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })
  const online = await until(
    () => {
      const value = status()
      return value?.phase === "online" && value.workerPid ? value : undefined
    },
    () => `host did not come online: ${stderr}`,
  ).catch(error => {
    throw new Error(`${error.message}\n${stderr}`)
  })
  const base = `http://127.0.0.1:${port}`
  await until(async () => (await fetch(`${base}/api/meta`).catch(() => undefined))?.ok, "panel")
  return { root, plugin, state, base, cli, status, online, stderr: () => stderr }
}

/** 把当前插件复制为“上一版本”，按需改动文件并同步组件清单。 */
function plantPrevious(plugin, version, edits) {
  const previous = path.join(plugin, ".update", "previous")
  fs.rmSync(previous, { recursive: true, force: true })
  for (const item of ["index.js", "dist", "native", "package.json"])
    fs.cpSync(path.join(plugin, item), path.join(previous, item), { recursive: true })
  const manifestFile = path.join(previous, "dist", "components.json")
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"))
  for (const [file, append] of Object.entries(edits)) {
    fs.appendFileSync(path.join(previous, file), append)
    manifest.files[file].sha256 = sha256(path.join(previous, file))
  }
  const packageFile = path.join(previous, "package.json")
  fs.writeFileSync(
    packageFile,
    JSON.stringify({ ...JSON.parse(fs.readFileSync(packageFile, "utf8")), version }),
  )
  manifest.version = version
  fs.writeFileSync(manifestFile, JSON.stringify(manifest))
}

async function login(base, state) {
  const headers = { Origin: base, "Content-Type": "application/json" }
  await fetch(`${base}/api/login/code/request`, { method: "POST", headers, body: "{}" })
  const code = fs.readFileSync(path.join(state, "login-code.txt"), "utf8").trim()
  const response = await fetch(`${base}/api/login/code/check`, {
    method: "POST",
    headers,
    body: JSON.stringify({ code }),
  })
  assert.equal(response.status, 200)
  return { Cookie: response.headers.get("set-cookie").split(";")[0] }
}

test("控制台级更新热替换线程，业务进程与登录会话都不中断", environmentOptions, async t => {
  const app = await fixture(t)
  const session = await login(app.base, app.state)
  plantPrevious(app.plugin, "0.0.1-hot", {
    "dist/web/server.js": "\n// hot-core-marker\n",
    "dist/panel/index.html": "\n<!-- hot-static-marker -->\n",
  })
  app.cli("rollback")
  const done = await until(() => {
    const value = app.status()
    return value?.update?.current === "0.0.1-hot" && value.update.phase === "idle"
      ? value
      : undefined
  }, "hot update did not finish")
  assert.equal(done.update.plan.level, "core")
  assert.equal(done.workerPid, app.online.workerPid)
  assert.equal(done.generation, app.online.generation)
  const meta = await until(async () => {
    const value = await (await fetch(`${app.base}/api/meta`).catch(() => undefined))?.json()
    return value?.version === "0.0.1-hot" ? value : undefined
  }, "panel thread was not swapped")
  assert.equal(meta.version, "0.0.1-hot")
  assert.match(await (await fetch(`${app.base}/`)).text(), /hot-static-marker/)
  assert.equal((await fetch(`${app.base}/api/session`, { headers: session })).status, 200)
  assert.match(
    fs.readFileSync(path.join(app.plugin, "dist/web/server.js"), "utf8"),
    /hot-core-marker/,
  )
})

test("业务侧还原立即重启业务一次，宿主与控制台保持运行", environmentOptions, async t => {
  // 还原视为紧急操作，不等待空闲；即使配置为维护时段也立即执行。
  const now = new Date()
  const hour = String((now.getHours() + 12) % 24).padStart(2, "0")
  const app = await fixture(t, {
    update: { workerRestart: "window", window: `${hour}:00-${hour}:01` },
  })
  const hostPid = app.online.hostPid
  plantPrevious(app.plugin, "0.0.2-worker", {
    "dist/worker-preload.js": "\n// worker-marker\n",
  })
  app.cli("rollback")
  const applied = await until(() => {
    const value = app.status()
    return value?.update?.current === "0.0.2-worker" &&
      value.update.phase === "idle" &&
      value.phase === "online"
      ? value
      : undefined
  }, "worker update was not applied")
  assert.equal(applied.update.plan.level, "worker")
  assert.equal(applied.hostPid, hostPid)
  assert.notEqual(applied.workerPid, app.online.workerPid)
  assert.equal(applied.generation, app.online.generation + 1)
  assert.equal(applied.update.pending, undefined)
  assert.equal(applied.update.hostRestartPending, false)
  assert.equal(applied.update.lastResult.ok, true)
  assert.match(
    fs.readFileSync(path.join(app.plugin, "dist/worker-preload.js"), "utf8"),
    /worker-marker/,
  )
  await until(async () => (await fetch(`${app.base}/api/meta`).catch(() => undefined))?.ok, "panel")
})

test("宿主级更新在受管宿主下只重启业务一次并提示宿主待重启", environmentOptions, async t => {
  const app = await fixture(t)
  plantPrevious(app.plugin, "0.0.3-host", {
    "dist/host/supervisor.js": "\n// host-marker\n",
  })
  app.cli("rollback")
  const done = await until(() => {
    const value = app.status()
    return value?.update?.current === "0.0.3-host" &&
      value.update.phase === "idle" &&
      value.phase === "online"
      ? value
      : undefined
  }, "host update did not finish")
  assert.equal(done.update.plan.level, "host")
  assert.equal(done.update.hostRestartPending, true)
  assert.notEqual(done.workerPid, app.online.workerPid)
  assert.equal(done.generation, app.online.generation + 1)
})

test("可自行重启的宿主：宿主级更新只重启一次，由新宿主确认成功", environmentOptions, async t => {
  const app = await fixture(t, {}, { YUNZAI_GUARD_COLD: "1" })
  plantPrevious(app.plugin, "0.0.4-relaunch", {
    "dist/host/supervisor.js": "\n// relaunch-marker\n",
  })
  app.cli("rollback")
  const done = await until(() => {
    const value = app.status()
    return value?.hostPid !== app.online.hostPid &&
      value?.update?.current === "0.0.4-relaunch" &&
      value.update.lastResult?.version === "0.0.4-relaunch" &&
      value.phase === "online"
      ? value
      : undefined
  }, "relaunched host did not confirm the update")
  assert.equal(done.update.lastResult.ok, true)
  assert.equal(done.update.hostRestartPending, false)
  assert.notEqual(done.workerPid, app.online.workerPid)
  assert.equal(fs.existsSync(path.join(app.state, "update-verify.json")), false)
  await until(async () => (await fetch(`${app.base}/api/meta`).catch(() => undefined))?.ok, "panel")
})

test("新宿主上业务无法上线时自动还原到原版本", environmentOptions, async t => {
  const app = await fixture(t, {}, { YUNZAI_GUARD_COLD: "1" })
  const original = app.online.update.current
  plantPrevious(app.plugin, "0.0.5-broken", {
    "dist/host/supervisor.js": "\n// broken-marker\n",
    "dist/worker-preload.js": "\nthrow new Error('broken worker preload')\n",
  })
  app.cli("rollback")
  // 能确认业务进程清理时整体还原并重新启动；Windows 上崩溃的业务进程无法确认后代时，
  // 只还原文件并保持熔断，不释放项目锁。两种情况下文件都必须回到原版本。
  const restored = await until(
    () => {
      const value = app.status()
      const settled = value?.phase === "online" || value?.phase === "tripped"
      return value?.update?.current === original &&
        value.update.lastResult?.ok === false &&
        settled &&
        !fs.existsSync(path.join(app.state, "update-verify.json"))
        ? value
        : undefined
    },
    "broken update was not reverted",
    150000,
  )
  if (restored.phase === "online") assert.match(restored.update.lastResult.message, /已自动还原至/)
  else
    assert.match(
      restored.update.lastResult.message,
      /已将文件还原至 .*确认没有残留进程后请重启宿主/,
    )
  assert.doesNotMatch(
    fs.readFileSync(path.join(app.plugin, "dist/worker-preload.js"), "utf8"),
    /broken worker preload/,
  )
  assert.doesNotMatch(
    fs.readFileSync(path.join(app.plugin, "dist/host/supervisor.js"), "utf8"),
    /broken-marker/,
  )
})
