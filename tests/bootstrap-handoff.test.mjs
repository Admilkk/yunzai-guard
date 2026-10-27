import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import test from "node:test"

const handoff = new URL("../dist/host/bootstrap/handoff.js", import.meta.url).href
const prefix = "BOOTSTRAP_HANDOFF_TEST "
const supported = ["linux", "win32"].includes(process.platform)

async function fixture(t, { redis = true, timeout = 12000 } = {}) {
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "guard-bootstrap-handoff-"))
  const hostFile = path.join(directory, "host.mjs")
  const serviceFile = path.join(directory, "service.mjs")
  const bootstrapFile = path.join(directory, "bootstrap.mjs")
  fs.writeFileSync(
    serviceFile,
    `
const announce = type => console.log(${JSON.stringify(prefix)} + JSON.stringify({ type, at: Date.now(), pid: process.pid }))
let finishing = false
const finish = type => {
  if (finishing) return
  finishing = true
  announce(type)
  process.exit(0)
}
setInterval(() => {}, 1000)
process.on("message", value => { if (value === "creator-finish") finish("service-creator-exit") })
process.once("disconnect", () => {
  announce("service-parent-disconnected")
  setTimeout(() => finish("service-delayed-exit"), 1000)
})
setTimeout(() => finish("service-safety-exit"), 20000).unref()
announce("service-ready")
`,
  )
  fs.writeFileSync(
    hostFile,
    `
import { waitForBootstrapHandoff } from ${JSON.stringify(handoff)}
const [bootstrapPid, redisArgument, timeout] = process.argv.slice(2).map(Number)
const controller = new AbortController()
const announce = (type, extra = {}) => console.log(${JSON.stringify(prefix)} + JSON.stringify({ type, at: Date.now(), pid: process.pid, ...extra }))
const cancel = value => { if (value?.type === "test-abort") controller.abort() }
process.on("message", cancel)
const safety = setTimeout(() => { announce("host-safety-exit"); process.exit(91) }, 20000)
try {
  const identities = await waitForBootstrapHandoff({
    bootstrapPid, redisPid: redisArgument || null, timeout, signal: controller.signal,
    bound: identities => announce("bound", { identities }),
  })
  announce("host-result", { outcome: "resolved", identities })
} catch (error) {
  announce("host-result", { outcome: "rejected", name: error.name, message: error.message })
} finally {
  clearTimeout(safety)
  process.off("message", cancel)
  if (process.connected) process.disconnect()
}
`,
  )
  fs.writeFileSync(
    bootstrapFile,
    `
import { spawn } from "node:child_process"
import { once } from "node:events"
const announce = (type, extra = {}) => console.log(${JSON.stringify(prefix)} + JSON.stringify({ type, at: Date.now(), pid: process.pid, ...extra }))
const service = ${redis ? `spawn(process.execPath, [${JSON.stringify(serviceFile)}], { windowsHide: true, detached: true, stdio: ["ignore", "inherit", "inherit", "ipc"] })` : "null"}
if (service) await once(service, "spawn")
const host = spawn(process.execPath, [${JSON.stringify(hostFile)}, String(process.pid), String(service?.pid || 0), ${JSON.stringify(String(timeout))}], {
  windowsHide: true, detached: true, stdio: ["ignore", "inherit", "inherit", "ipc"],
})
let armed
host.on("message", value => {
  if (value?.type !== "armed") return
  armed = value
  announce("armed", { value })
})
host.on("exit", (code, signal) => announce("host-exit", {
  code, signal, serviceAlive: service ? service.exitCode === null && service.signalCode === null : null,
}))
await once(host, "spawn")
announce("spawned", { hostPid: host.pid, redisPid: service?.pid || null })
let cleaning = false
const cleanup = async () => {
  if (cleaning) return
  cleaning = true
  const waits = []
  if (host.exitCode === null && host.signalCode === null) {
    waits.push(once(host, "close"))
    if (host.connected) host.send({ type: "test-abort" })
  }
  if (service && service.exitCode === null && service.signalCode === null) {
    waits.push(once(service, "close"))
    if (service.connected) service.send("creator-finish")
  }
  await Promise.all(waits)
  announce("creator-cleaned")
  if (process.connected) process.disconnect()
}
process.once("disconnect", () => { void cleanup() })
process.on("message", command => {
  if (command === "cleanup") return void cleanup()
  if (command === "exit-without-commit") return process.exit(0)
  if (command === "abort") return host.send({ type: "test-abort" })
  if (!["commit-and-exit", "wrong-nonce-and-exit", "commit-and-abort"].includes(command)) return
  if (!armed) throw Error("Creator attempted commit before the real armed message")
  const nonce = command === "wrong-nonce-and-exit"
    ? (armed.nonce[0] === "0" ? "1" : "0") + armed.nonce.slice(1) : armed.nonce
  host.send({ type: "bootstrap-handoff-commit", version: 1, nonce }, error => {
    if (error) throw error
    if (command === "commit-and-abort") host.send({ type: "test-abort" })
    else process.exit(0)
  })
})
`,
  )
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (key === "NODE_OPTIONS" || key.startsWith("YUNZAI_GUARD_")) delete env[key]
  const child = spawn(process.execPath, [bootstrapFile], {
    cwd: directory,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  const exited = once(child, "exit")
  const closed = once(child, "close")
  void exited.catch(() => {})
  void closed.catch(() => {})
  const events = []
  const waiters = new Set()
  let text = "",
    input = "",
    observerError
  const receive = chunk => {
    text += chunk
    input += chunk
    let newline
    while ((newline = input.indexOf("\n")) !== -1) {
      const line = input.slice(0, newline)
      input = input.slice(newline + 1)
      if (!line.startsWith(prefix)) continue
      const event = JSON.parse(line.slice(prefix.length))
      events.push(event)
      for (const waiter of waiters) waiter()
    }
  }
  child.stdout.on("data", receive)
  child.stderr.on("data", chunk => (text += chunk))
  child.once("error", error => {
    observerError = error
    for (const waiter of waiters) waiter()
  })
  const wait = (type, budget = 20000) =>
    new Promise((resolve, reject) => {
      let timer
      const check = () => {
        const event = events.find(value => value.type === type)
        if (!event && !observerError) return
        clearTimeout(timer)
        waiters.delete(check)
        if (observerError) reject(observerError)
        else resolve(event)
      }
      waiters.add(check)
      timer = setTimeout(() => {
        waiters.delete(check)
        reject(Error(`Missing ${type}\n${text}`))
      }, budget)
      check()
    })
  const send = command => {
    assert.ok(child.connected)
    child.send(command)
  }
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null && child.connected) send("cleanup")
    let timer
    try {
      const result = await Promise.race([
        closed,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error(`Fixture cleanup deadline\n${text}`)), 24000)
        }),
      ])
      assert.deepEqual(result, [0, null], text)
      assert.equal(
        events.some(value => /safety-exit$/.test(value.type)),
        false,
        text,
      )
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      assert.equal(path.dirname(fs.realpathSync(directory)), temporaryRoot)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
  const spawned = await wait("spawned")
  const armed = await wait("armed")
  assert.equal(armed.value.version, 1)
  assert.match(armed.value.nonce, /^[a-f0-9]{48}$/)
  const bound = await wait("bound")
  assert.deepEqual(
    bound.identities.map(identity => identity.pid).sort((a, b) => a - b),
    [child.pid, ...(redis ? [spawned.redisPid] : [])].sort((a, b) => a - b),
  )
  for (const identity of bound.identities) assert.match(identity.created, /^\d+$/)
  if (redis)
    assert.equal(
      bound.identities.find(identity => identity.pid === spawned.redisPid).parentPid,
      child.pid,
    )
  return { child, events, exited, spawned, bound, wait, send }
}

test(
  "private commit waits for the original parent and its detached delayed service to exit",
  { skip: !supported },
  async t => {
    const probe = await fixture(t)
    probe.send("commit-and-exit")
    await probe.exited
    await probe.wait("service-parent-disconnected")
    const first = await Promise.race([
      probe.wait("host-result"),
      probe.wait("service-delayed-exit"),
    ])
    assert.equal(
      first.type,
      "service-delayed-exit",
      "handoff must not release at parent exit alone",
    )
    const result = await probe.wait("host-result")
    assert.equal(result.outcome, "resolved")
    assert.deepEqual(result.identities, probe.bound.identities)
    assert.equal(probe.events.filter(event => event.type === "host-result").length, 1)
  },
)

test(
  "an external Redis needs no owned service identity but still requires parent exit and commit",
  { skip: !supported },
  async t => {
    const probe = await fixture(t, { redis: false })
    probe.send("commit-and-exit")
    await probe.exited
    const result = await probe.wait("host-result")
    assert.equal(result.outcome, "resolved")
    assert.deepEqual(result.identities, probe.bound.identities)
    assert.equal(result.identities.length, 1)
  },
)

for (const command of ["exit-without-commit", "wrong-nonce-and-exit"])
  test(
    `${command} rejects instead of releasing after disconnect`,
    { skip: !supported },
    async t => {
      const probe = await fixture(t)
      probe.send(command)
      const result = await probe.wait("host-result")
      assert.equal(result.outcome, "rejected")
      assert.match(result.message, /交接未提交即断开/)
      await probe.wait("service-delayed-exit")
      assert.equal(
        probe.events.some(event => event.outcome === "resolved"),
        false,
      )
    },
  )

test(
  "an uncommitted deadline closes only the observer while both original targets remain alive",
  { skip: !supported },
  async t => {
    const probe = await fixture(t, { timeout: 8000 })
    const result = await probe.wait("host-result")
    assert.equal(result.outcome, "rejected")
    assert.match(result.message, /超时|期限/i)
    const exited = await probe.wait("host-exit")
    assert.equal(exited.code, 0)
    assert.equal(exited.serviceAlive, true)
    assert.equal(probe.child.exitCode, null)
  },
)

for (const command of ["abort", "commit-and-abort"])
  test(
    `${command} rejects with both original targets live and never authorizes release`,
    { skip: !supported },
    async t => {
      const probe = await fixture(t)
      probe.send(command)
      const result = await probe.wait("host-result")
      assert.equal(result.outcome, "rejected")
      assert.match(result.message, /交接已取消/)
      const exited = await probe.wait("host-exit")
      assert.equal(exited.code, 0)
      assert.equal(
        exited.serviceAlive,
        true,
        "observer cancellation must not signal the owned service",
      )
      assert.equal(probe.child.exitCode, null)
      assert.equal(
        probe.events.some(event => event.outcome === "resolved"),
        false,
      )
    },
  )
