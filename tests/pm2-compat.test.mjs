import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ChildProcess } from "node:child_process"
import test from "node:test"
import { installPm2Compatibility } from "../dist/pm2/compat.js"

const immediate = () => new Promise(resolve => setImmediate(resolve))

function fixture(context, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-pm2-barrier-"))
  const launcher = path.join(root, "插件 空格", "dist", "launcher.js")
  fs.mkdirSync(path.dirname(launcher), { recursive: true })
  fs.writeFileSync(launcher, "")
  context.after(() => {
    assert.match(path.basename(root), /^guard-pm2-barrier-/)
    assert.equal(fs.realpathSync.native(path.dirname(root)), fs.realpathSync.native(os.tmpdir()))
    assert.equal(path.dirname(fs.realpathSync.native(root)), fs.realpathSync.native(os.tmpdir()))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const child = new ChildProcess()
  child.pid = 42345
  child.process = { pid: child.pid }
  child.pm2_env = {
    pm_id: 7,
    pm_exec_path: launcher,
    exec_mode: "fork_mode",
    kill_timeout: 1,
  }
  const reports = []
  const originalCalls = []
  const consumed = []
  let pollCallback
  const god = {
    clusters_db: { 7: child },
    processIsDead(pid, environment, callback, sigkill) {
      originalCalls.push({ receiver: this, pid, environment, callback, sigkill })
      pollCallback = callback
      return "original-return"
    },
    handleExit(exiting, ...args) {
      consumed.push({ receiver: this, child: exiting, args })
      this.clusters_db[exiting.pm2_env.pm_id].process.pid = 0
      return "original-exit-return"
    },
  }
  if (options.processIsDead) god.processIsDead = options.processIsDead
  if (options.handleExit) god.handleExit = options.handleExit
  const attachExit = () => child.once("exit", (...args) => god.handleExit(child, ...args))
  if (options.attachExit !== false) attachExit()
  installPm2Compatibility(god, {
    launcherPath: launcher,
    report: event => {
      reports.push(event)
      options.report?.(event)
    },
  })
  return {
    root,
    launcher,
    child,
    god,
    reports,
    originalCalls,
    consumed,
    attachExit,
    poll(...args) {
      assert.ok(pollCallback, "Original processIsDead must have installed its callback")
      return Reflect.apply(pollCallback, options.callbackThis ?? god, args)
    },
    exit(code = 0) {
      child.exitCode = code
      child.emit("exit", code, null)
    },
  }
}

test("PM2 kernel-dead polling cannot start a new generation before old exit consumption", async t => {
  const f = fixture(t)
  const result = []
  assert.equal(
    f.god.processIsDead(f.child.pid, f.child.pm2_env, (...args) => result.push(args)),
    "original-return",
  )
  f.poll(null, true)
  await immediate()
  assert.deepEqual(result, [])
  f.exit()
  assert.equal(f.consumed.length, 1)
  assert.equal(f.child.process.pid, 0)
  assert.equal(f.child.pid, 42345, "Immutable ChildProcess PID is the generation identity")
  assert.deepEqual(result, [], "Do not run stop/start callbacks inside exit listener dispatch")
  await immediate()
  assert.deepEqual(result, [[null, true]])
  assert.deepEqual(
    f.reports.map(event => event.event),
    ["pm2-exit-barrier-wait", "pm2-exit-barrier-complete"],
  )
  assert.equal(f.child.listenerCount("exit"), 0)
})

test("PM2 callback waits for original polling even when exit is consumed first", async t => {
  const receiver = {}
  const f = fixture(t, { callbackThis: receiver })
  const failure = { type: "timeout", msg: "original PM2 timeout" }
  const received = []
  f.god.processIsDead(
    f.child.pid,
    f.child.pm2_env,
    function (...args) {
      received.push({ receiver: this, args })
    },
    true,
  )
  f.exit(12)
  await immediate()
  assert.deepEqual(received, [])
  f.poll(failure, false, "extra original value")
  await immediate()
  assert.deepEqual(received, [{ receiver, args: [failure, false, "extra original value"] }])
  assert.equal(f.originalCalls[0].receiver, f.god)
  assert.equal(f.originalCalls[0].sigkill, true)
})

test("PM2 requires the original handleExit barrier as well as the native exit event", async t => {
  const f = fixture(t, { attachExit: false })
  let count = 0
  f.god.processIsDead(f.child.pid, f.child.pm2_env, () => count++)
  f.poll(null, true)
  f.exit()
  await immediate()
  assert.equal(count, 0)
  assert.equal(f.god.handleExit(f.child, 0, null), "original-exit-return")
  await immediate()
  assert.equal(count, 1)
})

test("PM2 handleExit reentrancy can install a barrier after native exit dispatch begins", async t => {
  let completed = 0
  let f
  f = fixture(t, {
    handleExit(child) {
      child.process.pid = 0
      this.processIsDead(child.pid, child.pm2_env, () => completed++)
      f.poll(null, true)
      assert.equal(completed, 0)
      return "handled"
    },
  })
  f.exit()
  await immediate()
  assert.equal(completed, 1)
})

test("PM2 stale exit from the old ChildProcess cannot mutate a reused PM2 id or PID", async t => {
  const f = fixture(t)
  let callbacks = 0
  f.god.processIsDead(f.child.pid, f.child.pm2_env, () => callbacks++)
  f.poll(null, true)
  const replacement = {
    pid: f.child.pid,
    process: { pid: f.child.pid },
    pm2_env: { ...f.child.pm2_env, pm_exec_path: path.join(f.root, "unrelated.js") },
  }
  f.god.clusters_db[7] = replacement
  f.exit()
  await immediate()
  assert.equal(f.consumed.length, 0)
  assert.equal(callbacks, 0)
  assert.equal(replacement.process.pid, 42345)
  assert.ok(f.reports.some(event => event.event === "pm2-stale-exit-dropped"))
  assert.equal(f.child.listenerCount("exit"), 0)
})

test("PM2 replacement between the exit event and deferred callback fails closed", async t => {
  const f = fixture(t)
  let callbacks = 0
  f.god.processIsDead(f.child.pid, f.child.pm2_env, () => callbacks++)
  f.poll(null, true)
  f.exit()
  f.god.clusters_db[7] = { ...f.child, process: { pid: 99999 } }
  await immediate()
  assert.equal(callbacks, 0)
  assert.ok(f.reports.some(event => event.reason === "process-generation-changed"))
})

test("PM2 duplicate original callbacks remain exactly once and allow callback reentrancy", async t => {
  const f = fixture(t)
  let calls = 0
  f.god.processIsDead(f.child.pid, f.child.pm2_env, () => {
    calls++
    f.poll(null, "duplicate during callback")
    f.god.clusters_db[7] = { ...f.child, process: { pid: 99999 } }
  })
  f.poll(null, true)
  f.poll(null, "duplicate before exit")
  f.exit()
  await immediate()
  await immediate()
  assert.equal(calls, 1)
})

test("PM2 non-target and cluster applications preserve original callbacks and return values", t => {
  const f = fixture(t)
  for (const change of [
    { pm_exec_path: path.join(f.root, "launcher.js") },
    { pm_exec_path: path.join(f.root, "other", "dist", "launcher.js") },
    { exec_mode: "cluster_mode" },
  ]) {
    const env = { ...f.child.pm2_env, ...change }
    const callback = () => {}
    assert.equal(f.god.processIsDead(88, env, callback, true), "original-return")
    assert.equal(f.originalCalls.at(-1).callback, callback)
    assert.equal(f.originalCalls.at(-1).environment, env)
    assert.equal(f.originalCalls.at(-1).pid, 88)
  }
  assert.deepEqual(f.reports, [])
  const other = { pm2_env: { ...f.child.pm2_env, exec_mode: "cluster_mode" }, process: { pid: 1 } }
  f.god.clusters_db[7] = other
  assert.equal(f.god.handleExit(other, 4), "original-exit-return")
  assert.equal(f.consumed[0].child, other)
})

test("PM2 missing ChildProcess or mismatched native PID refuses an unsafe stop callback", t => {
  const f = fixture(t)
  const pretend = { ...f.child, pid: 42345 }
  f.god.clusters_db[7] = pretend
  assert.equal(
    f.god.processIsDead(42345, f.child.pm2_env, () => assert.fail()),
    false,
  )
  f.god.clusters_db[7] = f.child
  assert.equal(
    f.god.processIsDead(42346, f.child.pm2_env, () => assert.fail()),
    false,
  )
  assert.equal(f.originalCalls.length, 0)
  assert.equal(f.reports.length, 2)
  assert.ok(f.reports.every(event => event.reason === "child-process-identity-unavailable"))
})

test("PM2 watchdog bounds missing exit confirmation without releasing a delayed restart", async t => {
  const f = fixture(t)
  let callbacks = 0
  f.god.processIsDead(f.child.pid, f.child.pm2_env, () => callbacks++)
  f.poll({ type: "timeout" })
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal(callbacks, 0)
  assert.ok(f.reports.some(event => event.reason === "exit-barrier-timeout"))
  assert.equal(f.child.listenerCount("exit"), 1, "Only PM2's original listener remains")
  f.exit()
  f.poll(null, true)
  await immediate()
  assert.equal(callbacks, 0)
  const count = f.originalCalls.length
  assert.equal(
    f.god.processIsDead(f.child.pid, f.child.pm2_env, () => callbacks++),
    false,
  )
  assert.equal(f.originalCalls.length, count)
})

test("PM2 original processIsDead exceptions retain their failure semantics and release listeners", t => {
  const error = new Error("original poll failure")
  const f = fixture(t, {
    processIsDead() {
      throw error
    },
  })
  assert.throws(() => f.god.processIsDead(f.child.pid, f.child.pm2_env, () => assert.fail()), error)
  assert.equal(f.child.listenerCount("exit"), 1)
  assert.ok(f.reports.some(event => event.reason === "process-is-dead-threw"))
})

test("PM2 original handleExit exceptions do not release a queued stop callback", async t => {
  const error = new Error("original exit failure")
  const f = fixture(t, {
    handleExit() {
      throw error
    },
  })
  f.god.processIsDead(f.child.pid, f.child.pm2_env, () => assert.fail())
  f.poll(null, true)
  assert.throws(() => f.exit(), error)
  await immediate()
  assert.equal(f.child.listenerCount("exit"), 0)
  assert.ok(f.reports.some(event => event.reason === "handle-exit-threw"))
})

test("PM2 target uses canonical paths and Windows case folding, multiple targets are idempotent", async t => {
  const f = fixture(t, {
    report() {
      throw new Error("Unavailable diagnostics")
    },
  })
  const originalWrapper = f.god.processIsDead
  installPm2Compatibility(f.god, { launcherPath: f.launcher })
  assert.equal(f.god.processIsDead, originalWrapper)
  const equivalent = path.join(path.dirname(f.launcher), ".", path.basename(f.launcher))
  f.child.pm2_env.pm_exec_path =
    process.platform === "win32" ? equivalent.toUpperCase() : equivalent
  let calls = 0
  f.god.processIsDead(f.child.pid, f.child.pm2_env, () => calls++)
  f.poll(null, true)
  f.exit()
  await immediate()
  assert.equal(calls, 1)
  const other = path.join(f.root, "other.js")
  fs.writeFileSync(other, "")
  installPm2Compatibility(f.god, { launcherPath: other })
  assert.equal(f.god.processIsDead, originalWrapper)
})

test("PM2 replacing or deleting the launcher cannot disable its already verified exact path", async t => {
  const f = fixture(t)
  fs.rmSync(f.launcher)
  let calls = 0
  f.god.processIsDead(f.child.pid, f.child.pm2_env, () => calls++)
  f.poll(null, true)
  await immediate()
  assert.equal(calls, 0)
  f.exit()
  await immediate()
  assert.equal(calls, 1)
})

test("PM2 an already recognized ChildProcess retains its barrier if mutable path metadata changes", async t => {
  const f = fixture(t)
  let calls = 0
  f.god.processIsDead(f.child.pid, f.child.pm2_env, () => calls++)
  f.child.pm2_env.pm_exec_path = path.join(f.root, "removed-alias.js")
  f.god.processIsDead(f.child.pid, f.child.pm2_env, () => calls++)
  for (const call of f.originalCalls) call.callback(null, true)
  await immediate()
  assert.equal(calls, 0)
  f.exit()
  await immediate()
  assert.equal(calls, 2)
})

test("PM2 malformed God objects are rejected before any method is patched", t => {
  const f = fixture(t)
  for (const clusters_db of [null, undefined, [], 1]) {
    const processIsDead = () => {}
    const handleExit = () => {}
    const god = { clusters_db, processIsDead, handleExit }
    assert.throws(
      () => installPm2Compatibility(god, { launcherPath: f.launcher }),
      /PM2 God 结构不受支持/,
    )
    assert.equal(god.processIsDead, processIsDead)
    assert.equal(god.handleExit, handleExit)
  }
})

test("PM2 compatibility shares one installation between module copies and rejects unknown registries", async t => {
  const f = fixture(t)
  const copy = await import("../dist/pm2-compat-v2.js?separate-module-copy")
  const processIsDead = f.god.processIsDead
  const handleExit = f.god.handleExit
  copy.installPm2Compatibility(f.god, { launcherPath: f.launcher })
  assert.equal(f.god.processIsDead, processIsDead)
  assert.equal(f.god.handleExit, handleExit)
  for (const value of [0, {}, { protocol: 99 }]) {
    const god = { clusters_db: {}, processIsDead() {}, handleExit() {} }
    const before = god.processIsDead
    Object.defineProperty(god, Symbol.for("yunzai-guard.pm2-compat.v1"), { value })
    assert.throws(
      () => copy.installPm2Compatibility(god, { launcherPath: f.launcher }),
      /登记表|登记记录/,
    )
    assert.equal(god.processIsDead, before)
  }
})
