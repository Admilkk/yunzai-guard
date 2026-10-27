import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"

const launcher = fileURLToPath(new URL("../dist/launcher.js", import.meta.url))
const environmentOptions = { skip: !["win32", "linux"].includes(process.platform) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function removeOwnTemp(root) {
  assert.match(path.basename(root), /^guard-(manager-signals|pm2-entry)-/)
  assert.equal(fs.realpathSync.native(path.dirname(root)), fs.realpathSync.native(os.tmpdir()))
  assert.equal(path.dirname(fs.realpathSync.native(root)), fs.realpathSync.native(os.tmpdir()))
  fs.rmSync(root, { recursive: true, force: true })
}
async function until(predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(25)
  }
  throw new Error(message)
}
function recentEvents(file) {
  if (!fs.existsSync(file)) return []
  const handle = fs.openSync(file, "r")
  try {
    const size = fs.fstatSync(handle).size
    const start = Math.max(0, size - 8192)
    const bytes = Buffer.alloc(Math.min(size, 8192))
    fs.readSync(handle, bytes, 0, bytes.length, start)
    const lines = bytes.toString("utf8").split("\n")
    if (start) lines.shift()
    return lines
      .filter(Boolean)
      .slice(-12)
      .map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return { partial: line.slice(0, 512) }
        }
      })
  } finally {
    fs.closeSync(handle)
  }
}
async function fixture({
  onlineDelay = 120,
  exitDelay = 60,
  writeStdout = false,
  holdOnline = false,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-manager-signals-"))
  const state = path.join(root, "data/yunzai-guard")
  fs.mkdirSync(state, { recursive: true })
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}')
  fs.writeFileSync(
    path.join(state, "settings.json"),
    JSON.stringify({ shutdownTimeout: 1200, startupTimeout: 10000 }),
  )
  fs.writeFileSync(
    path.join(root, "app.js"),
    `
import fs from "node:fs"
import { EventEmitter } from "node:events"
const bot = new EventEmitter()
bot.em = () => {}
bot.prepareEvent = () => {}
bot.exitEvent = async () => {
  fs.writeFileSync("cleanup.json", JSON.stringify({pid:process.pid,time:Date.now()}))
  await new Promise(resolve=>setTimeout(resolve,${exitDelay}))
}
bot.redisExit = async () => {}
globalThis.Bot = bot
const online=()=>{fs.writeFileSync("online.json", JSON.stringify({pid:process.pid,time:Date.now()}));bot.emit("online")}
if(${holdOnline}){
  const gate=setInterval(()=>{if(fs.existsSync("allow-online")){clearInterval(gate);online()}},25)
}else setTimeout(online,${onlineDelay})
setInterval(() => {${writeStdout ? 'process.stdout.write("guard-output-probe\\n")' : ""}},25)
`,
  )
  const env = { ...process.env }
  // 本夹具验证通用管理器 IPC；真实 PM2 身份和自动注册由隔离守护进程集成测试覆盖。
  for (const key of ["NODE_OPTIONS", "pm_id", "PM2_HOME", "NODE_APP_INSTANCE"]) delete env[key]
  const child = spawn(process.execPath, [launcher], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  const messages = []
  let stderr = ""
  child.on("message", message => messages.push({ message, time: Date.now() }))
  child.stdout.resume()
  child.stderr.on("data", chunk => {
    stderr += chunk
  })
  const exited = once(child, "exit")
  void exited.catch(() => {})
  const controlPath = path.join(state, "control.json")
  const reportPath = fileURLToPath(
    new URL(`./runs/environment-signals/${path.basename(root)}/report.json`, import.meta.url),
  )
  const credentials = new Set()
  let startupFailure
  let forced = false
  const diagnostics = () => {
    try {
      const control = JSON.parse(fs.readFileSync(controlPath))
      if (typeof control.token === "string") credentials.add(control.token)
    } catch {}
    let text = stderr.slice(-8192)
    for (const credential of credentials) text = text.replaceAll(credential, "[redacted]")
    text = text.replace(
      /((?:token|password|secret|ticket|authorization)["']?\s*[:=]\s*["']?)[^\s,"']+/gi,
      "$1[redacted]",
    )
    let events
    try {
      events = recentEvents(path.join(state, "events.jsonl"))
    } catch (error) {
      events = [{ diagnosticReadError: error.message }]
    }
    return JSON.parse(
      JSON.stringify(
        {
          pid: child.pid,
          exitCode: child.exitCode,
          signalCode: child.signalCode,
          controlPresent: fs.existsSync(controlPath),
          stderr: text,
          events,
          reportPath,
        },
        (key, value) =>
          /token|password|secret|ticket|authorization/i.test(key) ? "[redacted]" : value,
      ),
    )
  }
  async function wait(predicate, message) {
    try {
      return await until(async () => {
        const value = await predicate()
        if (value) return value
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`${message}: host exited before the condition`)
        return false
      }, message)
    } catch (error) {
      startupFailure = `${error.message}\n${JSON.stringify(diagnostics())}`
      throw new Error(startupFailure, { cause: error })
    }
  }
  async function request(command) {
    const { token, port } = JSON.parse(fs.readFileSync(controlPath, "utf8"))
    credentials.add(token)
    const socket = net.connect({ host: "127.0.0.1", port })
    return new Promise((resolve, reject) => {
      let input = ""
      socket.setTimeout(3000, () => socket.destroy(new Error("Test control timeout")))
      socket.on("error", reject)
      socket.on("connect", () => socket.write(JSON.stringify({ token, command }) + "\n"))
      socket.on("data", chunk => {
        input += chunk
        if (input.includes("\n")) {
          socket.end()
          resolve(JSON.parse(input.split("\n")[0]))
        }
      })
    })
  }
  return {
    root,
    child,
    messages,
    exited,
    wait,
    request,
    control: () => fs.existsSync(controlPath),
    stderr: () => diagnostics().stderr,
    async close() {
      let cleanupError
      if (child.exitCode === null && child.signalCode === null) {
        try {
          if (child.connected) child.send("shutdown")
          else await request("stop")
        } catch {}
        const deadline = Date.now() + 10000
        while (child.exitCode === null && child.signalCode === null && Date.now() < deadline)
          await sleep(25)
        if (child.exitCode === null && child.signalCode === null) {
          forced = true
          child.kill("SIGKILL")
          try {
            // 仅处理失败后的清理，保留原 10 秒优雅退出预算，并等待此 ChildProcess 的原生退出。
            await until(
              () => child.exitCode !== null || child.signalCode !== null,
              "Own fixture process exit was not confirmed after SIGKILL",
              1000,
            )
          } catch (error) {
            cleanupError = error.message
          }
        }
      }
      const actualExitConfirmed = child.exitCode !== null || child.signalCode !== null
      if (actualExitConfirmed) await exited
      const report = {
        ...diagnostics(),
        startupFailure,
        forced,
        actualExitConfirmed,
        cleanupError,
        holdOnline,
        startupWaitBudgetMs: 15000,
        coreStartupTimeoutMs: 10000,
        coreShutdownTimeoutMs: 1200,
        gracefulCleanupBudgetMs: 10000,
        forcedExitConfirmationBudgetMs: 1000,
        forcedCleanupIsFailure: true,
      }
      fs.mkdirSync(path.dirname(reportPath), { recursive: true })
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n")
      if (actualExitConfirmed) removeOwnTemp(root)
      if (forced || !actualExitConfirmed)
        throw new Error(`Fixture required forced or unconfirmed cleanup\n${JSON.stringify(report)}`)
    },
  }
}

test(
  "manager IPC ready follows core online and Windows-compatible shutdown message runs cleanup",
  environmentOptions,
  async () => {
    const probe = await fixture()
    try {
      await probe.wait(
        () => probe.messages.find(value => value.message === "ready"),
        "No manager ready notification",
      )
      const online = JSON.parse(fs.readFileSync(path.join(probe.root, "online.json"), "utf8"))
      assert.ok(probe.messages.find(value => value.message === "ready").time >= online.time)
      assert.equal((await probe.request("status")).phase, "online")
      probe.child.send("shutdown")
      const [code] = await probe.exited
      assert.equal(code, 0, probe.stderr())
      assert.ok(
        fs.existsSync(path.join(probe.root, "cleanup.json")),
        "graceful application cleanup ran",
      )
      assert.equal(probe.control(), false, "control file removed after stopping")
    } finally {
      await probe.close()
    }
  },
)

test(
  "manager shutdown before core readiness stops startup without a misleading ready notification",
  environmentOptions,
  async () => {
    const probe = await fixture({ holdOnline: true })
    try {
      await probe.wait(probe.control, "Host control was not created")
      assert.equal(
        fs.existsSync(path.join(probe.root, "online.json")),
        false,
        "Core readiness remains behind the explicit gate",
      )
      probe.child.send("shutdown")
      const [code] = await probe.exited
      assert.equal(code, 0, probe.stderr())
      assert.equal(
        probe.messages.some(value => value.message === "ready"),
        false,
      )
      assert.equal(probe.control(), false)
    } finally {
      await probe.close()
    }
  },
)

test(
  "manager IPC disconnect stops the supervised host and runs worker cleanup",
  environmentOptions,
  async () => {
    const probe = await fixture()
    try {
      await probe.wait(
        () => probe.messages.some(value => value.message === "ready"),
        "No manager ready notification",
      )
      probe.child.disconnect()
      await probe.wait(
        () => probe.child.exitCode !== null || probe.child.signalCode !== null,
        "Host ignored manager IPC disconnect",
      )
      assert.equal(probe.child.exitCode, 0, probe.stderr())
      assert.ok(fs.existsSync(path.join(probe.root, "cleanup.json")))
      assert.equal(probe.control(), false)
      const events = fs.readFileSync(
        path.join(probe.root, "data/yunzai-guard/events.jsonl"),
        "utf8",
      )
      assert.equal(events.includes('"type":"recovery-scheduled"'), false)
    } finally {
      await probe.close()
    }
  },
)

test(
  "closing the output consumer gracefully stops instead of spending recovery budget on EPIPE",
  environmentOptions,
  async () => {
    const probe = await fixture({ writeStdout: true })
    try {
      await probe.wait(
        () => probe.messages.some(value => value.message === "ready"),
        "No manager ready notification",
      )
      probe.child.stdout.destroy()
      await probe.wait(
        () => probe.child.exitCode !== null || probe.child.signalCode !== null,
        "Host did not stop after its output consumer closed",
      )
      assert.equal(probe.child.exitCode, 0, probe.stderr())
      assert.ok(fs.existsSync(path.join(probe.root, "cleanup.json")))
      assert.equal(probe.control(), false)
      const events = fs.readFileSync(
        path.join(probe.root, "data/yunzai-guard/events.jsonl"),
        "utf8",
      )
      assert.equal(events.includes('"type":"recovery-scheduled"'), false)
      assert.equal(events.includes('"type":"recovery-tripped"'), false)
    } finally {
      await probe.close()
    }
  },
)

test(
  "a forged PM2 context without parent IPC is rejected before an unguarded entry can continue",
  environmentOptions,
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-pm2-entry-"))
    try {
      const entry = path.join(root, "app.mjs")
      const pluginURL = new URL("../dist/entry/plugin.js", import.meta.url).href
      fs.writeFileSync(
        entry,
        `globalThis.plugin=class{constructor(){}};globalThis.logger={error:message=>console.error(message)};globalThis.start_type="internal";const{YunzaiGuard}=await import(${JSON.stringify(pluginURL)});await new YunzaiGuard().init();console.log("UNGUARDED_ENTRY_CONTINUED");`,
      )
      const env = { ...process.env, pm_id: "0", PM2_HOME: path.join(root, "pm2") }
      delete env.NODE_OPTIONS
      const result = spawnSync(process.execPath, [entry], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 10000,
      })
      assert.equal(result.status, 78, result.stderr)
      assert.match(result.stderr, /PM2|pm2/)
      assert.equal(result.stdout.includes("UNGUARDED_ENTRY_CONTINUED"), false)
      assert.equal(fs.existsSync(path.join(root, "data/yunzai-guard/control.json")), false)
    } finally {
      removeOwnTemp(root)
    }
  },
)
