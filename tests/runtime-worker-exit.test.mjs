import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import test from "node:test"

const behavior = new URL("../dist/native-sandbox/behavior.js", import.meta.url).href
const pluginId = "worker-exit-probe"

async function shortNestedWorkers(t, action) {
  const parent = fs.realpathSync(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(parent, "guard-worker-exit-"))
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), parent)
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const marker = path.join(directory, "must-not-exist")
  const inner = `
import { parentPort } from "node:worker_threads"
${
  action
    ? `import { execFileSync } from "node:child_process"
let denied
try {
  execFileSync(process.execPath, ["-e", ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`)}])
} catch (error) { denied = error.code }
parentPort.postMessage({ done: true, denied })`
    : `parentPort.postMessage({ done: true })`
}
`
  const outer = `
import { Worker, parentPort, workerData } from "node:worker_threads"
const child = new Worker(${JSON.stringify(inner)}, { eval: true, execArgv: [] })
child.on("message", value => parentPort.postMessage(value))
child.on("error", error => { throw error })
child.on("exit", code => {
  if (code) throw Error("Inner Worker failed: " + code)
  const latch = new Int32Array(workerData)
  Atomics.store(latch, 0, 1)
  Atomics.notify(latch, 0)
})
`
  const entry = path.join(directory, "main.mjs")
  fs.writeFileSync(
    entry,
    `
import assert from "node:assert/strict"
import { installNativeBehavior } from ${JSON.stringify(behavior)}
const events = []
const handle = installNativeBehavior({
  pluginId: ${JSON.stringify(pluginId)},
  identity: { id: "exit-main", generation: 3 },
  settings: ${JSON.stringify({ protect: { enabled: false }, rules: action ? [{ id: "exit-exec", plugin: pluginId, operation: "execFileSync", action }] : [] })},
  emit: event => events.push(event),
})
await handle.ready
const { Worker } = await import("node:worker_threads")
const latch = new SharedArrayBuffer(4)
const worker = new Worker(${JSON.stringify(outer)}, { eval: true, execArgv: [], workerData: latch })
let result
worker.on("message", value => { result = value })
const exited = new Promise((resolve, reject) => {
  worker.once("error", reject)
  worker.once("exit", code => code ? reject(Error("Outer Worker failed: " + code)) : resolve())
})
// 等待内层完成时不处理父进程私有端口，随后让父进程保持忙碌，以便外层 Worker 自然退出。
assert.notEqual(Atomics.wait(new Int32Array(latch), 0, 0, 5000), "timed-out")
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
await exited
handle.dispose()
console.log(JSON.stringify({ result, events }))
`,
  )
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (key === "NODE_OPTIONS" || key.startsWith("YUNZAI_GUARD_")) delete env[key]
  const child = spawn(process.execPath, [entry], {
    cwd: directory,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "",
    stderr = ""
  child.stdout.on("data", chunk => (stdout += chunk))
  child.stderr.on("data", chunk => (stderr += chunk))
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000)
  try {
    const [code, signal] = await once(child, "close")
    assert.equal(code, 0, `${stderr}\n${stdout}\nSignal:${signal}`)
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  }
  const output = JSON.parse(stdout.trim())
  assert.deepEqual(output.result, action ? { done: true, denied: "GUARD_DENIED" } : { done: true })
  assert.equal(fs.existsSync(marker), false)
  const registrations = output.events.filter(
    event => event.operation === "worker-runtime-registered",
  )
  const exits = output.events.filter(event => event.operation === "worker-runtime-exited")
  assert.equal(registrations.length, 2)
  assert.equal(exits.length, 2)
  assert.equal(new Set(registrations.map(event => event.target)).size, 2)
  for (const registered of registrations) {
    const exit = exits.find(event => event.target === registered.target)
    assert.ok(exit)
    assert.ok(output.events.indexOf(registered) < output.events.indexOf(exit))
  }
  assert.equal(
    output.events.some(event => event.operation === "runtime-bootstrap-failed"),
    false,
  )
  if (action) {
    const attempts = output.events.filter(event => event.ruleId === "exit-exec")
    assert.equal(
      attempts.length,
      1,
      "a drained frame must not also emit through the async listener",
    )
    assert.equal(attempts[0].action, action)
    assert.equal(attempts[0].plugin, pluginId)
    assert.equal(attempts[0].details.blocked, true)
    assert.equal(attempts[0].details.runtime.kind, "thread")
  }
}

test("naturally finished nested Workers drain each registration before exit exactly once", async t => {
  await shortNestedWorkers(t)
})

test("exit draining preserves a nested deny report and its absent command side effect", async t => {
  await shortNestedWorkers(t, "deny")
})

test("critical restart ACK remains effective while the parent event loop is busy", async t => {
  await shortNestedWorkers(t, "restart")
})
