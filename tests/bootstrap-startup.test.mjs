import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import test from "node:test"
import { readAuditRecords } from "./audit-reader.mjs"

const entry = new URL("../dist/entry/plugin.js", import.meta.url).href

async function run(source, pm2 = false, expectedCode = 0, timeout = 5000, prelude = "") {
  const temporaryRoot = await fs.realpath(os.tmpdir())
  const directory = await fs.mkdtemp(path.join(temporaryRoot, "guard-bootstrap-startup-"))
  const env = { ...process.env }
  for (const key of ["pm_id", "PM2_HOME", "NODE_APP_INSTANCE", "NODE_OPTIONS", "PM2_NODE_OPTIONS"])
    delete env[key]
  if (pm2) env.pm_id = "0"
  try {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
assert.equal(process.connected === true, ${JSON.stringify(pm2)})
globalThis.plugin = class { constructor() {} }
globalThis.logger = { error: console.error, info: console.log }
globalThis.start_type = "internal"
globalThis.Bot = Object.assign(new EventEmitter(), {
  stat: { online: 1 },
  exitEvent: async () => {},
})
${prelude}
const { YunzaiGuard } = await import(${JSON.stringify(entry)})
${source}`,
      ],
      {
        cwd: directory,
        env,
        windowsHide: true,
        stdio: pm2 ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
      },
    )
    const result = await new Promise((resolve, reject) => {
      let stdout = ""
      let stderr = ""
      let error
      child.stdout.setEncoding("utf8").on("data", value => (stdout += value))
      child.stderr.setEncoding("utf8").on("data", value => (stderr += value))
      child.on("error", value => {
        error = value
      })
      const timer = setTimeout(() => {
        error = new Error("Bootstrap component timed out")
        child.kill("SIGKILL")
      }, timeout)
      child.once("close", (code, signal) => {
        clearTimeout(timer)
        if (error || code !== expectedCode) {
          const failure = new Error(
            `Bootstrap component failed (${code ?? signal}): ${error?.message ?? ""}\n${stderr}`,
          )
          Object.assign(failure, { code, signal, stdout, stderr })
          reject(failure)
        } else resolve({ stdout, stderr })
      })
    })
    const events = readAuditRecords(path.join(directory, "data/yunzai-guard"))
      .map(row => JSON.stringify(row))
      .join("\n")
    return { ...result, events }
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot)
    assert.match(path.basename(directory), /^guard-bootstrap-startup-[a-zA-Z0-9]+$/)
    const stat = await fs.lstat(directory)
    assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true)
    assert.equal(await fs.realpath(directory), path.resolve(directory))
    await fs.rm(directory, { recursive: true, force: true })
  }
}

test("cold init returns while other loader initialization can still use the open Redis", async () => {
  const result = await run(`
let closed = false
globalThis.redis = Object.assign(new EventEmitter(), {
  isOpen: true,
  get: async () => "original-data",
  disconnect: async () => { closed = true },
  quit: async () => { closed = true },
})
await new YunzaiGuard().init()
assert.equal(Bot.stat.online, 1)
assert.equal(await redis.get("key"), "original-data")
await new YunzaiGuard().init()
assert.equal(Bot.listenerCount("online"), 1)
assert.equal(closed, false)
console.log("INITIALIZATION_CONTINUES_WITH_OPEN_REDIS")
process.exit(0)
`)
  assert.match(result.stdout, /INITIALIZATION_CONTINUES_WITH_OPEN_REDIS/)
})

test("PM2 stop before online cancels startup and closes resources only once", async () => {
  const result = await run(
    `
let exits = 0
Bot.exitEvent = async () => {
  assert.equal(++exits, 1)
  await new Promise(resolve => setTimeout(resolve, 25))
  console.log("STOPPED_WITHOUT_HANDOFF")
}
await new YunzaiGuard().init()
await new YunzaiGuard().init()
assert.equal(Bot.listenerCount("online"), 1)
process.emit("message", "shutdown")
process.emit("message", "shutdown")
Bot.stat.online = 2
Bot.emit("online")
assert.equal(Bot.listenerCount("online"), 0)
setTimeout(() => process.exit(99), 2000)
`,
    true,
  )
  assert.match(result.stdout, /STOPPED_WITHOUT_HANDOFF/)
  assert.doesNotMatch(result.stderr, /接管失败/)
})

test("PM2 registration shares the startup deadline and cannot be cut short by handshake time", async () => {
  const result = await run(
    `
import fs from "node:fs"
fs.mkdirSync("data/yunzai-guard", { recursive: true })
fs.writeFileSync("data/yunzai-guard/settings.json", JSON.stringify({
  startupTimeout: 500, handshakeTimeout: 100, shutdownTimeout: 100,
}))
Bot.stat.online = 2
const handoffs = []
process.send = (message, callback) => { handoffs.push(message); callback?.(null); return true }
await new YunzaiGuard().init()
await advance(0)
assert.equal(sharedBudget.remainingMs(), 500)
await advance(101)
assert.equal(handoffs.length, 0)
await advance(450)
assert.equal(handoffs.length, 1)
assert.equal(handoffs[0].type, "yunzai-guard-pm2-handoff")
assert.equal(sharedBudget.remainingMs(), 50)
assert.deepEqual([...timers.values()].map(timer => timer.at), [500])
console.log("REGISTRATION_AND_HANDOFF_SHARE_ORIGINAL_DEADLINE")
process.exit(0)
`,
    true,
    0,
    5000,
    `
import { registerHooks } from "node:module"
import { performance } from "node:perf_hooks"
globalThis.clock = 0
Object.defineProperty(performance, "now", { value: () => clock })
const timers = new Map()
let nextTimer = 0
globalThis.setTimeout = (callback, delay) => {
  const id = ++nextTimer
  timers.set(id, { at: clock + delay, callback })
  return id
}
globalThis.clearTimeout = id => timers.delete(id)
const advance = async now => {
  clock = now
  for (const [id, timer] of [...timers]) if (timer.at <= clock) {
    timers.delete(id)
    timer.callback()
  }
  await new Promise(resolve => setImmediate(resolve))
}
registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith("/pm2/auto.js")) return nextLoad(url, context)
  return { format: "module", shortCircuit: true, source: \`
    export async function registerCurrentPm2Application(options, deadline) {
      globalThis.sharedBudget = deadline
      await new Promise(resolve => setTimeout(resolve, 450))
      return { requiresHandoff: true, nonce: "a".repeat(64) }
    }
  \` }
} })
`,
  )
  assert.match(result.stdout, /REGISTRATION_AND_HANDOFF_SHARE_ORIGINAL_DEADLINE/)
})

test(
  "failed ordinary preparation disconnects and confirms supervisor cleanup before bootstrap exits",
  { skip: !["linux", "win32"].includes(process.platform) },
  async () => {
    const result = await run(
      `
globalThis.redis = { get: async () => "still-open" }
Bot.stat.online = 2
Bot.exitEvent = async () => { throw Error("SELF_AUTHORED_EXIT_HOOK_FAILURE") }
await new YunzaiGuard().init()
`,
      false,
      1,
      20000,
    )
    assert.match(result.stderr, /SELF_AUTHORED_EXIT_HOOK_FAILURE/)
    assert.doesNotMatch(result.stderr, /接管取消清理未确认/)
    const events = result.events
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line))
    assert.ok(events.some(event => event.type === "bootstrap-resources-bound"))
    assert.ok(events.some(event => event.type === "handoff-failed"))
    assert.ok(events.some(event => event.type === "host-process-exit" && event.code === 1))
    assert.equal(
      events.some(
        event => event.type === "worker-spawn" || event.type === "bootstrap-exit-confirmed",
      ),
      false,
    )
  },
)
