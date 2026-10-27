import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import test from "node:test"

const moduleUrl = new URL("../dist/host/bootstrap/exit-plan.js", import.meta.url).href

async function owner(t, mode, inspect) {
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "guard-bootstrap-exit-plan-"))
  const finalState = path.join(directory, "exit-state.json")
  const watchdog = path.join(directory, "service-watchdog")
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), temporaryRoot)
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const entry = path.join(directory, "owner.mjs")
  const service = `
const fs = require("node:fs")
setTimeout(() => {
  try { fs.writeFileSync(${JSON.stringify(watchdog)}, "watchdog") } catch {}
  process.exit(99)
}, 4000)
setInterval(() => {}, 1000)
`
  fs.writeFileSync(
    entry,
    `
import assert from "node:assert/strict"
import fs from "node:fs"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { performance } from "node:perf_hooks"
import { createBootstrapExitPlan } from ${JSON.stringify(moduleUrl)}
const mode = ${JSON.stringify(mode)}
const calls = []
let phase = "running", committed = false
let service, originalPid
if (mode !== "external") {
  service = spawn(process.execPath, ["-e", ${JSON.stringify(service)}], {
    stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
  })
  await once(service, "spawn")
  originalPid = service.pid
  const kill = service.kill.bind(service)
  service.kill = signal => {
    calls.push({ operation: "signal", signal, phase })
    return kill(signal)
  }
}
const client = {
  process: service ?? { pid: process.pid, kill() { calls.push("wrong-process") } },
  isOpen: true,
  async save() {
    calls.push("save")
    if (mode === "save-fail") throw Error("SAVE failed")
    if (mode === "save-timeout") await new Promise(() => {})
    if (mode === "changed-process") client.process = { kill() { calls.push("wrong-process") } }
    if (mode === "changed-pid") service.pid++
  },
  async quit() { calls.push("quit"); this.isOpen = false },
  async disconnect() { calls.push("disconnect"); this.isOpen = false },
}
let current = client
const bot = {
  async exitEvent(reason, timeout) {
    assert.equal(reason, "restart")
    assert.ok(timeout > 0)
    calls.push("restart")
    if (mode === "hook-fail") throw Error("Hook failed")
    if (mode === "hook-timeout") await new Promise(() => {})
    if (mode === "changed-client") current = { isOpen: true }
    if (mode === "save-timeout") await new Promise(resolve => setTimeout(resolve, 30))
  },
}
process.once("exit", () => { phase = "process-exit" })
const plan = createBootstrapExitPlan(bot, client, () => current)
process.once("exit", () => fs.writeFileSync(${JSON.stringify(finalState)}, JSON.stringify({ calls, committed, isOpen: client.isOpen })))
process.on("message", message => { if (message === "exit") process.exit(0) })
const started = performance.now()
let failure
const preparing = plan.prepare(mode.endsWith("timeout") ? 80 : 2000)
assert.equal(plan.prepare(5000), preparing, "prepare is a single operation")
try {
  await preparing
  plan.assertCurrent()
  committed = true
} catch (error) {
  failure = error.message
  if (mode.startsWith("changed-")) assert.throws(() => plan.assertCurrent(), /已变化/)
  if (mode === "changed-pid") service.pid = originalPid
  await assert.rejects(plan.prepare(5000), error)
}
phase = "after-prepare"
process.send({
  type: "prepared", redisPid: plan.redisPid, originalPid, calls, committed, failure,
  isOpen: client.isOpen, elapsedMs: performance.now() - started,
  serviceAlive: service ? service.exitCode === null && service.signalCode === null : null,
})
`,
  )
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (key === "NODE_OPTIONS" || key.startsWith("YUNZAI_GUARD_")) delete env[key]
  const child = spawn(process.execPath, [entry], {
    env,
    cwd: directory,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  let output = ""
  child.stdout.on("data", chunk => (output += chunk))
  child.stderr.on("data", chunk => (output += chunk))
  const closed = once(child, "close")
  let prepared
  const message = new Promise((resolve, reject) => {
    child.on("message", value => {
      if (value?.type === "prepared") resolve(value)
    })
    child.once("error", reject)
    child.once("exit", code => reject(Error(`Owner exited before inspection: ${code}\n${output}`)))
  })
  const deadline = setTimeout(() => child.kill("SIGKILL"), 8000)
  try {
    prepared = await message
    await inspect(prepared)
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.connected) child.send("exit")
    const [code, signal] = await closed
    clearTimeout(deadline)
    assert.equal(code, 0, `${output}\nSignal:${signal}`)
  }
  const final = JSON.parse(fs.readFileSync(finalState, "utf8"))
  assert.equal(fs.existsSync(watchdog), false, "owned service must stop before its safety watchdog")
  assert.equal(final.isOpen, true)
  assert.equal(final.calls.includes("quit"), false)
  assert.equal(final.calls.includes("disconnect"), false)
  assert.equal(final.calls.includes("wrong-process"), false)
  const signals = final.calls.filter(value => value?.operation === "signal")
  assert.deepEqual(
    signals,
    mode === "external" ? [] : [{ operation: "signal", signal: "SIGTERM", phase: "process-exit" }],
  )
  return { prepared, final }
}

test("bootstrap prepare keeps the owned service/client alive until actual process exit", async t => {
  const { final } = await owner(t, "owned", state => {
    assert.equal(state.committed, true)
    assert.equal(state.redisPid, state.originalPid)
    assert.equal(state.serviceAlive, true)
    assert.equal(state.isOpen, true)
    assert.deepEqual(state.calls, ["restart", "save"])
  })
  assert.equal(final.committed, true)
})

test("external Redis is never saved, closed or signalled by the exit plan", async t => {
  await owner(t, "external", state => {
    assert.equal(state.committed, true)
    assert.equal(state.redisPid, null)
    assert.equal(state.isOpen, true)
    assert.deepEqual(state.calls, ["restart"])
  })
})

for (const [mode, failure, calls] of [
  ["hook-fail", /Hook failed/, ["restart"]],
  ["save-fail", /SAVE failed/, ["restart", "save"]],
  ["hook-timeout", /退出钩子超时/, ["restart"]],
  ["save-timeout", /Redis SAVE 操作超时/, ["restart", "save"]],
  ["changed-client", /客户端已变化/, ["restart"]],
  ["changed-process", /服务已变化/, ["restart", "save"]],
  ["changed-pid", /PID 已变化/, ["restart", "save"]],
])
  test(`bootstrap ${mode} rejects preparation without closing the original service`, async t => {
    const { final } = await owner(t, mode, state => {
      assert.equal(state.committed, false)
      assert.match(state.failure, failure)
      assert.deepEqual(state.calls, calls)
      assert.equal(state.serviceAlive, true)
      assert.equal(state.isOpen, true)
    })
    assert.equal(final.committed, false)
  })
