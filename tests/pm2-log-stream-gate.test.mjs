import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"
import { ChildProcess, spawnSync } from "node:child_process"
import { EventEmitter, errorMonitor } from "node:events"
import { PassThrough } from "node:stream"
import { createRequire } from "node:module"
import test from "node:test"
import {
  createPm2ForkLogCapture,
  pm2LogGateFor,
  pm2LogDrainTimeout,
} from "../dist/pm2/log-stream-gate-v1.js"
import { installPm2Compatibility } from "../dist/pm2/compat.js"
import { resolveCachedLoggingUtility } from "../dist/pm2/god-context.js"
import { registerPm2ApplicationWithGod } from "../dist/pm2/daemon.js"

// PM2 ForkMode.js: Copyright 2013-2022 the PM2 project authors. All rights reserved.
// Use is governed by its LICENSE: node_modules/pm2/LICENSE (AGPL-3.0).
// Source: https://github.com/Unitech/pm2/blob/6.0.14/lib/God/ForkMode.js
// 使用自有流单独验证固定版本的 forkClose 函数，不启动守护进程、PM2 应用或业务源码。
const knownCloseSource = `function forkClose(status) {
        try {
          for(var k in stds){
            if (stds[k] && stds[k].destroy) stds[k].destroy();
            else if (stds[k] && stds[k].end) stds[k].end();
            else if (stds[k] && stds[k].close) stds[k].close();
            stds[k] = stds[k]._file;
          }
        } catch(e) { God.logAndGenerateError(e);}
      }`

const immediate = () => new Promise(resolve => setImmediate(resolve))
async function bounded(promise, timeout = 2000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("component deadline exceeded")), timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
function blankChild() {
  const child = new ChildProcess()
  child.pid = 43213
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pm2_env = { pm_id: 2, exec_mode: "fork_mode", kill_timeout: 1000 }
  child.process = { pid: child.pid }
  child.exitCode = null
  child.signalCode = null
  return child
}
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-pm2-log-"))
  const stds = options.disabled
    ? { out: "/dev/null", err: "NULL" }
    : { out: path.join(root, "out.log"), err: path.join(root, "err.log") }
  const paths = { ...stds }
  const reports = []
  const errors = []
  const sequence = []
  const writers = []
  const peers = []
  const child = blankChild()
  let forkCloseCalls = 0
  let capturedReturn
  let ready
  const readyPromise = new Promise(resolve => {
    ready = resolve
  })
  const callbackReceiver = {}
  let beforeCallbackCalled = false
  const utility = {
    startLogging(streams, callback) {
      const open = []
      for (const key of Object.keys(streams)) {
        if (streams[key].includes("NULL") || streams[key].includes("/dev/null")) continue
        const file = streams[key]
        const stream = fs.createWriteStream(file, { flags: "a" })
        stream._file = file
        stream.on("error", error => errors.push(error))
        writers.push(stream)
        streams[key] = stream
        open.push(
          new Promise((resolve, reject) => {
            const onError = error => reject(error)
            stream.once("open", () => {
              stream.removeListener("error", onError)
              resolve()
            })
            stream.once("error", onError)
          }),
        )
      }
      const done = () => {
        if (!beforeCallbackCalled) {
          beforeCallbackCalled = true
          options.beforeCallback?.({ utility, paths, peers })
        }
        return callback.call(callbackReceiver, null, "original-value")
      }
      if (open.length) void Promise.all(open).then(done)
      else capturedReturn = done()
      return "utility-return"
    },
  }
  const originalUtility = utility.startLogging
  const capture = createPm2ForkLogCapture({
    utility,
    expectedPaths: paths,
    timeout: options.timeout ?? 1000,
    report: event => reports.push(event),
  })
  const reloadCalls = []
  let gate
  const nativeClose = vm.runInNewContext("(" + knownCloseSource + ")", {
    stds,
    God: { logAndGenerateError: error => errors.push(error) },
  })
  const close = options.unknownClose
    ? function forkClose() {
        forkCloseCalls++
      }
    : nativeClose
  const runReturn = capture.run(() =>
    utility.startLogging(stds, function (error, value) {
      assert.equal(this, callbackReceiver)
      assert.equal(error, null)
      assert.equal(value, "original-value")
      child.once("exit", close)
      child._reloadLogs = function (...args) {
        reloadCalls.push({ receiver: this, args })
        if (options.reloadThrows) throw options.reloadThrows
        if (typeof args[0] === "function") args[0].call(this, null, "reload-result")
        return "reload-return"
      }
      child.stdout.on("data", data => {
        if (!options.disabled) stds.out.write(data)
      })
      child.stderr.on("data", data => {
        if (!options.disabled) stds.err.write(data)
      })
      const originalRaw = child.rawListeners("exit")[0]
      gate = capture.bind(child)
      if (options.unknownClose) assert.equal(child.rawListeners("exit")[0], originalRaw)
      child.once("exit", () => {
        sequence.push("core-exit")
        child._reloadLogs = null
      })
      ready()
      return "fork-callback-return"
    }),
  )
  assert.equal(utility.startLogging, originalUtility)
  await bounded(readyPromise)
  t.after(async () => {
    child.stdout.destroy()
    child.stderr.destroy()
    for (const stream of [...writers, ...peers]) stream.destroy()
    await immediate()
    assert.match(path.basename(root), /^guard-pm2-log-/)
    assert.equal(fs.realpathSync.native(path.dirname(root)), fs.realpathSync.native(os.tmpdir()))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    child,
    writers,
    peers,
    paths,
    stds,
    reports,
    errors,
    sequence,
    gate,
    capture,
    utility,
    originalUtility,
    reloadCalls,
    runReturn,
    capturedReturn,
    get forkCloseCalls() {
      return forkCloseCalls
    },
    exit(code = 0, signal = null) {
      child.exitCode = code
      child.signalCode = signal
      child.emit("exit", code, signal)
    },
  }
}

test("PM2 log gate drains real pending writes and EOF/close before original forkClose", async t => {
  const f = await fixture(t)
  const body = "末尾-byte-".repeat(32768)
  f.child.stdout.write(body)
  f.child.stderr.write("stderr-tail")
  assert.equal(f.writers[0].writableFinished, false)
  f.exit()
  assert.equal(f.gate.result, undefined)
  assert.equal(f.writers[0].destroyed, false)
  f.child.stdout.end()
  f.child.stderr.end()
  assert.deepEqual(await bounded(f.gate.settled), { status: "drained" })
  assert.equal(fs.readFileSync(f.paths.out, "utf8"), body)
  assert.equal(fs.readFileSync(f.paths.err, "utf8"), "stderr-tail")
  assert.ok(f.writers.every(writer => writer.writableFinished && writer.closed))
  assert.equal(f.stds.out, f.paths.out)
  assert.equal(f.stds.err, f.paths.err)
  assert.equal(f.child._reloadLogs, null)
  assert.equal(f.reports.filter(event => event.event === "pm2-log-drained").length, 1)
  assert.equal(f.errors.length, 0)
  assert.equal(pm2LogGateFor(f.child), f.gate)
  f.child.emit("exit", 0, null)
  assert.equal(f.reports.length, 1)
})

test("PM2 logging restores Utility before a synchronous no-file callback and peer reentry", async t => {
  let peerCalls = 0
  const f = await fixture(t, {
    disabled: true,
    beforeCallback({ utility }) {
      utility.startLogging({ out: "/dev/null", err: "NULL" }, () => peerCalls++)
    },
  })
  assert.equal(peerCalls, 1)
  assert.equal(f.runReturn, "utility-return")
  assert.equal(f.capturedReturn, "fork-callback-return")
  f.child.stdout.end()
  f.child.stderr.end()
  f.exit()
  assert.equal((await bounded(f.gate.settled)).status, "drained")
})

test("PM2 async open callback may reenter an ordinary peer without ending its stream", async t => {
  const f = await fixture(t, {
    beforeCallback({ utility, peers, paths }) {
      const peer = { out: paths.out, err: "NULL" }
      utility.startLogging(peer, () => {})
      peers.push(peer.out)
    },
  })
  f.child.stdout.end()
  f.child.stderr.end()
  f.exit()
  assert.equal((await bounded(f.gate.settled)).status, "drained")
  assert.ok(f.peers.every(peer => !peer.writableEnded && !peer.destroyed))
  await new Promise((resolve, reject) =>
    f.peers[0].write("peer-still-writable", error => (error ? reject(error) : resolve())),
  )
})

test("PM2 same-path peer first cannot donate a captured container to a later target callback", async t => {
  const child = blankChild()
  t.after(() => {
    child.stdout.destroy()
    child.stderr.destroy()
  })
  const paths = { out: "/dev/null", err: "NULL" }
  const utility = {
    startLogging(_stds, cb) {
      setImmediate(cb)
      return "original"
    },
  }
  const original = utility.startLogging
  const capture = createPm2ForkLogCapture({ utility, expectedPaths: paths, timeout: 10 })
  let targetGate
  let ready
  const done = new Promise(resolve => {
    ready = resolve
  })
  capture.run(() => {
    utility.startLogging({ ...paths }, () => {})
    utility.startLogging({ ...paths }, () => {
      targetGate = capture.bind(child)
      ready()
    })
  })
  await bounded(done)
  assert.equal(utility.startLogging, original)
  assert.equal((await targetGate.settled).reason, "logging-callback-owner-unconfirmed")
  assert.equal(child.listenerCount("exit"), 0)
})

test("PM2 unknown same-name exit listener is retained rather than mistaken for forkClose", async t => {
  const f = await fixture(t, { unknownClose: true })
  assert.equal((await f.gate.settled).reason, "fork-close-listener-unsupported")
  f.exit()
  assert.equal(f.forkCloseCalls, 1)
})

test("PM2 close without EOF is not reported as a drained output", async t => {
  const f = await fixture(t, { timeout: 25 })
  f.child.stdout.destroy()
  f.child.stderr.end()
  f.exit()
  assert.equal((await bounded(f.gate.settled)).reason, "logging-drain-timeout")
  assert.equal(f.child.stdout.readableEnded, false)
})

test("PM2 descendant-held output pipe gets one bounded diagnostic deadline", async t => {
  const f = await fixture(t, { timeout: 25 })
  f.exit()
  const result = await bounded(f.gate.settled)
  assert.deepEqual(result, { status: "not-drained", reason: "logging-drain-timeout" })
  assert.equal(f.stds.out, f.paths.out)
  assert.equal(f.reports.length, 1)
})

for (const [code, signal] of [
  [19, null],
  [null, "SIGKILL"],
]) {
  test("PM2 log drain preserves nonzero/signal exit " + String(code ?? signal), async t => {
    const f = await fixture(t)
    f.child.stdout.end("nonzero-tail")
    f.child.stderr.end()
    f.exit(code, signal)
    assert.equal((await bounded(f.gate.settled)).status, "drained")
    assert.equal(fs.readFileSync(f.paths.out, "utf8"), "nonzero-tail")
  })
}

test("PM2 stream error is observed without adding a swallowing error listener", async t => {
  const f = await fixture(t)
  assert.equal(f.writers[0].listenerCount("error"), 1)
  assert.equal(f.writers[0].listenerCount(errorMonitor), 1)
  const error = new Error("original-stream-error")
  f.writers[0].emit("error", error)
  assert.deepEqual(f.errors, [error])
  f.exit()
  assert.equal((await bounded(f.gate.settled)).reason, "logging-stream-error")
  assert.equal(f.writers[0].listenerCount("error"), 1)
  assert.equal(f.writers[0].listenerCount(errorMonitor), 0)
})

test("PM2 reload taints only this generation and preserves this/args/callback/return", async t => {
  const f = await fixture(t)
  const receiver = {}
  const callbackCalls = []
  function cb(...args) {
    callbackCalls.push({ receiver: this, args })
  }
  assert.equal(f.child._reloadLogs.call(receiver, cb, "extra"), "reload-return")
  assert.deepEqual(f.reloadCalls, [{ receiver, args: [cb, "extra"] }])
  assert.deepEqual(callbackCalls, [{ receiver, args: [null, "reload-result"] }])
  f.exit()
  assert.equal((await bounded(f.gate.settled)).reason, "reload-logs-called")
  assert.equal(f.child._reloadLogs, null)
  assert.equal(
    f.reports.some(event => event.event === "pm2-log-drained"),
    false,
  )
})

test("PM2 saved reload wrapper invoked during drain cancels further end calls and preserves throw", async t => {
  const failure = new Error("original-reload-throw")
  const f = await fixture(t, { reloadThrows: failure })
  const reload = f.child._reloadLogs
  f.exit()
  assert.throws(
    () => reload.call(f.child, "same-arg"),
    error => error === failure,
  )
  assert.equal((await bounded(f.gate.settled)).reason, "reload-logs-called")
  f.child.stdout.end()
  f.child.stderr.end()
  await immediate()
  assert.ok(f.writers.every(writer => !writer.writableEnded))
  assert.equal(f.child._reloadLogs, null)
})

test("PM2 Utility temporary wrapper does not overwrite a concurrent replacement", () => {
  const replacement = () => "replacement"
  const utility = {
    startLogging() {
      utility.startLogging = replacement
      return "old"
    },
  }
  const capture = createPm2ForkLogCapture({ utility, expectedPaths: {}, timeout: 10 })
  assert.equal(
    capture.run(() => utility.startLogging({}, () => {})),
    "old",
  )
  assert.equal(utility.startLogging, replacement)
})

test("PM2 Utility unknown Proxy and a concurrent accessor are not executed or overwritten", () => {
  let traps = 0
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        traps++
        throw new Error("proxy trap")
      },
    },
  )
  const unknown = createPm2ForkLogCapture({ utility: proxy, expectedPaths: {}, timeout: 10 })
  assert.equal(
    unknown.run(() => "unchanged"),
    "unchanged",
  )
  assert.equal(traps, 0)
  let getters = 0
  const utility = {
    startLogging() {
      Object.defineProperty(utility, "startLogging", {
        configurable: true,
        get() {
          getters++
          throw new Error("getter")
        },
      })
      return "original"
    },
  }
  const capture = createPm2ForkLogCapture({ utility, expectedPaths: {}, timeout: 10 })
  assert.equal(
    capture.run(() => utility.startLogging({}, () => {})),
    "original",
  )
  assert.equal(getters, 0)
  assert.equal(typeof Object.getOwnPropertyDescriptor(utility, "startLogging").get, "function")
})

test("PM2 logging resolver uses only an already loaded exact Utility and missing input stays diagnostic", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-pm2-log-resolver-"))
  t.after(() => {
    assert.match(path.basename(root), /^guard-pm2-log-resolver-/)
    assert.equal(fs.realpathSync.native(path.dirname(root)), fs.realpathSync.native(os.tmpdir()))
    fs.rmSync(root, { recursive: true, force: true })
  })
  assert.equal(resolveCachedLoggingUtility(root), undefined)
  fs.mkdirSync(path.join(root, "lib"))
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}')
  const file = path.join(root, "lib", "Utility.js")
  fs.writeFileSync(file, "module.exports={startLogging(){return 'self-authored'}}\n")
  assert.equal(resolveCachedLoggingUtility(root), undefined)
  const require = createRequire(import.meta.url)
  const utility = require(file)
  assert.equal(resolveCachedLoggingUtility(root), utility)
  delete require.cache[require.resolve(file)]
})

for (const observed of [false, true])
  test("PM2 original forkClose throw remains fatal to the exit chain, observed=" + observed, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-pm2-log-throw-"))
    t.after(() => {
      assert.match(path.basename(root), /^guard-pm2-log-throw-/)
      assert.equal(fs.realpathSync.native(path.dirname(root)), fs.realpathSync.native(os.tmpdir()))
      fs.rmSync(root, { recursive: true, force: true })
    })
    const program = `
import fs from 'node:fs'; import vm from 'node:vm'; import path from 'node:path';
import {ChildProcess} from 'node:child_process'; import {PassThrough} from 'node:stream';
import {createPm2ForkLogCapture} from ${JSON.stringify(new URL("../dist/pm2/log-stream-gate-v1.js", import.meta.url).href)};
import {installPm2Compatibility} from ${JSON.stringify(new URL("../dist/pm2-compat.js", import.meta.url).href)};
const root=${JSON.stringify(root)};
let consumed=0,stopped=0,uncaught=0,loggerCalls=0,poll;
const observed=${JSON.stringify(observed)};
if(observed)process.on('uncaughtException',error=>{uncaught++;console.error(error.stack);setTimeout(()=>{console.log(JSON.stringify({consumed,stopped,uncaught,loggerCalls}));process.exit(37)},20)});
const streams={out:path.join(root,'out.log'),err:path.join(root,'err.log')};
const expected={...streams};
const utility={startLogging(stds,cb){const pending=[];for(const key of Object.keys(stds)){const file=stds[key];const writer=fs.createWriteStream(file);writer._file=file;writer.on('error',()=>{});stds[key]=writer;pending.push(new Promise(resolve=>writer.once('open',resolve)))}Promise.all(pending).then(cb)}};
const capture=createPm2ForkLogCapture({utility,expectedPaths:expected,timeout:1000});
capture.run(()=>utility.startLogging(streams,()=>{
const child=new ChildProcess();child.pid=12345;child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdout.resume();child.stderr.resume();
const launcher=path.join(root,'launcher.js');fs.writeFileSync(launcher,'');child.pm2_env={pm_id:2,pm_exec_path:launcher,exec_mode:'fork_mode',kill_timeout:1000};child.exitCode=null;child.signalCode=null;
const god={clusters_db:{2:child},processIsDead(pid,env,cb){poll=cb},handleExit(){consumed++},logAndGenerateError(){loggerCalls++;throw new Error('original-logger-uncaught')}};
const close=vm.runInNewContext('('+${JSON.stringify(knownCloseSource)}+')',{stds:streams,God:god});
child.once('exit',close);child._reloadLogs=()=>{};const gate=capture.bind(child);
installPm2Compatibility(god,{launcherPath:launcher});child.once('exit',(...args)=>god.handleExit(child,...args));god.processIsDead(child.pid,child.pm2_env,()=>stopped++);poll(null,true);
gate.settled.then(result=>console.log(JSON.stringify(result)));
streams.out={destroy(){throw new Error('original-destroy-error')}};
child.stdout.end();child.stderr.end();child.exitCode=0;child.emit('exit',0,null);
}));`
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, observed ? 37 : 1)
    assert.equal(result.signal, null)
    assert.match(result.stderr, /original-logger-uncaught/)
    const lines = result.stdout
      .trim()
      .split(/\r?\n/)
      .map(line => JSON.parse(line))
    assert.deepEqual(lines[0], {
      status: "not-drained",
      reason: "logging-fork-close-threw",
      fatal: true,
    })
    if (observed)
      assert.deepEqual(lines[1], { consumed: 0, stopped: 0, uncaught: 1, loggerCalls: 1 })
  })

test("PM2 native exit chain and stop callback wait for the same successful log drain once", async t => {
  const f = await fixture(t)
  const launcher = path.join(f.root, "launcher.js")
  fs.writeFileSync(launcher, "")
  f.child.pm2_env.pm_exec_path = launcher
  let poll
  const consumed = []
  const callbacks = []
  const god = {
    clusters_db: { 2: f.child },
    processIsDead(_pid, _env, callback) {
      poll = callback
      return "native-poll"
    },
    handleExit(child, ...args) {
      consumed.push({ child, args })
      return "native-exit"
    },
  }
  installPm2Compatibility(god, { launcherPath: launcher })
  f.child.once("exit", (...args) => god.handleExit(f.child, ...args))
  assert.equal(
    god.processIsDead(f.child.pid, f.child.pm2_env, (...args) => callbacks.push(args)),
    "native-poll",
  )
  poll(null, true)
  f.child.stdout.write("last-line")
  f.exit(9)
  await immediate()
  assert.deepEqual(consumed, [])
  assert.deepEqual(callbacks, [])
  f.child.stdout.end()
  f.child.stderr.end()
  assert.equal((await bounded(f.gate.settled)).status, "drained")
  await immediate()
  await immediate()
  assert.equal(consumed.length, 1)
  assert.deepEqual(consumed[0].args, [9, null])
  assert.deepEqual(callbacks, [[null, true]])
  assert.ok(f.writers.every(writer => writer.closed))
})

test("PM2 log timeout remains diagnostic and releases original lifecycle rather than failState", async t => {
  const f = await fixture(t, { timeout: 25 })
  const launcher = path.join(f.root, "launcher.js")
  fs.writeFileSync(launcher, "")
  f.child.pm2_env.pm_exec_path = launcher
  let poll
  let consumed = 0
  let callbacks = 0
  const reports = []
  const god = {
    clusters_db: { 2: f.child },
    processIsDead(_pid, _env, callback) {
      poll = callback
    },
    handleExit() {
      consumed++
    },
  }
  installPm2Compatibility(god, { launcherPath: launcher, report: event => reports.push(event) })
  f.child.once("exit", (...args) => god.handleExit(f.child, ...args))
  god.processIsDead(f.child.pid, f.child.pm2_env, () => callbacks++)
  poll(null, true)
  f.exit()
  assert.equal((await bounded(f.gate.settled)).status, "not-drained")
  await immediate()
  await immediate()
  assert.equal(consumed, 1)
  assert.equal(callbacks, 1)
  assert.equal(
    reports.some(event => event.event === "pm2-exit-barrier-failed"),
    false,
  )
})

test("PM2 log budget stays strictly below the existing minimum or triple kill budget", () => {
  for (const value of [undefined, 0, 1, 10, 1600, 60000, 120000]) {
    const native = typeof value === "number" ? Math.max(0, value) : 1600
    const deadline = Math.max(1000, Math.min(180000, native * 3))
    assert.ok(pm2LogDrainTimeout(value) < deadline)
  }
})

test("PM2 actual agent future launcher fork binds its captured log gate before core exit listeners", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-pm2-log-agent-"))
  const children = []
  const writers = []
  t.after(async () => {
    for (const child of children) {
      child.stdout.destroy()
      child.stderr.destroy()
    }
    for (const writer of writers) writer.destroy()
    await immediate()
    assert.match(path.basename(root), /^guard-pm2-log-agent-/)
    assert.equal(fs.realpathSync.native(path.dirname(root)), fs.realpathSync.native(os.tmpdir()))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const app = path.join(root, "app.js")
  const launcher = path.join(root, "plugins", "guard", "dist", "launcher.js")
  fs.mkdirSync(path.dirname(launcher), { recursive: true })
  fs.writeFileSync(app, "")
  fs.writeFileSync(launcher, "")
  const initial = blankChild()
  children.push(initial)
  initial.pm2_env = {
    pm_id: 2,
    unique_id: "self-authored-log-agent",
    pm_exec_path: launcher,
    pm_cwd: root,
    exec_mode: "fork_mode",
    status: "online",
    env: {},
    kill_timeout: 1000,
    pm_out_log_path: path.join(root, "out.log"),
    pm_err_log_path: path.join(root, "err.log"),
  }
  const errors = []
  const originalUtility = function (stds, callback) {
    const pending = Object.keys(stds).map(
      key =>
        new Promise(resolve => {
          const file = stds[key]
          const writer = fs.createWriteStream(file)
          writers.push(writer)
          writer._file = file
          writer.on("error", error => errors.push(error))
          stds[key] = writer
          writer.once("open", resolve)
        }),
    )
    void Promise.all(pending).then(callback)
    return "native-start-logging"
  }
  const utility = { startLogging: originalUtility }
  const consumed = []
  let poll
  const god = {
    clusters_db: { 2: initial },
    processIsDead(_pid, _env, callback) {
      poll = callback
    },
    handleExit(child, ...args) {
      consumed.push({ child, args })
    },
    restartProcessId() {},
    forkMode(environment, callback) {
      const stds = { out: environment.pm_out_log_path, err: environment.pm_err_log_path }
      return utility.startLogging(stds, () => {
        const child = blankChild()
        children.push(child)
        child.pm2_env = environment
        child.once(
          "exit",
          vm.runInNewContext("(" + knownCloseSource + ")", {
            stds,
            God: { logAndGenerateError: error => errors.push(error) },
          }),
        )
        child._reloadLogs = () => {}
        child.stdout.on("data", data => stds.out.write(data))
        child.stderr.on("data", data => stds.err.write(data))
        callback.call(this, null, child)
      })
    },
  }
  const result = await registerPm2ApplicationWithGod(
    god,
    {
      pmId: 2,
      pid: initial.pid,
      root,
      launcherPath: launcher,
      shutdownTimeout: 1000,
      startupTimeout: 1000,
      nonce: "test-log-gate-nonce-012345",
      requestRestart: false,
      expectedDaemonPid: process.pid,
      pm2Root: root,
    },
    { daemonPid: process.pid, loggingUtility: utility },
  )
  assert.equal(result.status, "registered")
  const spawned = await bounded(
    new Promise(resolve => {
      assert.equal(
        god.forkMode(
          { ...initial.pm2_env, env: { ...initial.pm2_env.env } },
          function (error, child) {
            assert.equal(this, god)
            assert.equal(error, null)
            god.clusters_db[2] = child
            child.once("exit", (...args) => {
              child._reloadLogs = null
              god.handleExit(child, ...args)
            })
            resolve(child)
          },
        ),
        "native-start-logging",
      )
      assert.equal(utility.startLogging, originalUtility)
    }),
  )
  const gate = pm2LogGateFor(spawned)
  assert.ok(gate)
  assert.equal(gate.result, undefined)
  let stopped = 0
  god.processIsDead(spawned.pid, spawned.pm2_env, () => stopped++)
  poll(null, true)
  spawned.stdout.write("actual-agent-tail")
  spawned.exitCode = 0
  spawned.emit("exit", 0, null)
  assert.equal(consumed.length, 0)
  assert.equal(stopped, 0)
  spawned.stdout.end()
  spawned.stderr.end()
  assert.equal((await bounded(gate.settled)).status, "drained")
  await immediate()
  await immediate()
  assert.equal(consumed.length, 1)
  assert.equal(stopped, 1)
  assert.equal(fs.readFileSync(initial.pm2_env.pm_out_log_path, "utf8"), "actual-agent-tail")
  assert.equal(errors.length, 0)
})
