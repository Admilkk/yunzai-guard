import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { EventEmitter } from "node:events"
import { randomBytes } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"
import ts from "typescript"
import test from "node:test"

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const build = process.env.GUARD_TEST_STARTUP_BUILD || path.join(repository, "dist")
const { M } = await import(pathToFileURL(path.join(build, "shared/messages.js")).href)

// 使用自有模拟资源执行真实编译函数体，不启动顶层 supervisor 服务、进程处理器或应用。
function evaluate(file, names, bindings) {
  const text = fs.readFileSync(file, "utf8")
  const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const functions = names.map(name => {
    const matches = parsed.statements.filter(
      item => ts.isFunctionDeclaration(item) && item.name?.text === name,
    )
    assert.equal(matches.length, 1, name)
    return matches[0].getText(parsed).replace(/^export\s+(?=(?:async\s+)?function\b)/, "")
  })
  // 编译后的函数体通过模块导入的 M 取文案。
  const context = vm.createContext({ M, ...bindings })
  const source = functions
    .join("\n")
    .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(file).href))
  new vm.Script(source + "\nglobalThis.testApi = {" + names.join(",") + "}", {
    filename: file,
  }).runInContext(context)
  return { context, ...context.testApi }
}

function fixture(options = {}) {
  const steps = [],
    records = [],
    auditDrops = [],
    exits = [],
    child = new EventEmitter()
  Object.assign(child, {
    pid: 100,
    exitCode: null,
    signalCode: null,
    connected: true,
    send(message, callback) {
      if (message.type === "shutdown") {
        steps.push("shutdown")
        if (!options.keepAlive) child.exitCode = 0
      }
      callback?.(null)
      return true
    },
    sandboxDispose() {
      steps.push("dispose-scope")
    },
    sandboxTransportStats() {
      return undefined
    },
    sandboxCanonicalStats() {
      return undefined
    },
  })
  if (options.windowsSetupError) {
    const on = child.on
    child.on = function (name, callback) {
      if (name === "runtime-message") throw new Error("windows-setup-failure")
      return on.call(this, name, callback)
    }
  }
  const broker = {
    manifestPath: "owned-manifest",
    async listen() {
      steps.push("listen")
      if (options.listenError) throw options.listenError
    },
    async close() {
      steps.push("broker-close")
      if (options.brokerCloseError) throw options.brokerCloseError
    },
    prepareAudit() {
      steps.push("broker-prepare")
    },
    transportStats() {
      return {}
    },
  }
  const deadline = { remainingMs: () => 0 }
  class AuditReceiver {
    register() {}
    prepare() {
      steps.push("audit-prepare")
    }
    closePermitForHost() {
      return { nonce: "fixed", deadline }
    }
    stats() {
      return { generation: 1, sources: [], retired: { sources: 0 } }
    }
    drop(...args) {
      auditDrops.push(args)
    }
    noteOutboundFailure() {}
    async flush() {
      steps.push("audit-flush")
    }
  }
  const spec = {
    executable: "owned-bwrap",
    args: [],
    env: {},
    extraStdio: [],
    dispose() {
      steps.push("release-launch-fds")
      if (options.releaseError) throw options.releaseError
    },
    observe(original) {
      assert.equal(original, child)
      steps.push("observe")
      if (options.emitEarlyError)
        queueMicrotask(() => child.emit("error", new Error("early-error")))
      if (options.observeError) throw options.observeError
    },
    async waitForExit(original) {
      assert.equal(original, child)
      steps.push("scope-wait")
      if (options.scopeWaitError) throw options.scopeWaitError
    },
  }
  const bindings = {
    process: {
      platform: options.platform || "linux",
      env: {},
      execPath: "owned-node",
      connected: false,
      exit: code => exits.push(code),
    },
    path,
    URL,
    randomBytes,
    AuditReceiver,
    RuntimeBroker: function (_settings, _generation, _projectId, _onEvent, auditCallbacks) {
      broker.auditCallbacks = auditCallbacks
      return broker
    },
    assertOriginalWindowsChildProbeRuntime() {
      steps.push("runtime-preflight")
      if (options.preflightError) throw options.preflightError
    },
    settings: {
      isolationMode: options.mode || "os-sandbox",
      handshakeTimeout: 5000,
      startupTimeout: 15000,
      shutdownTimeout: 10000,
    },
    configuration: { hasPending: false, state: {}, async applyPending() {} },
    stopping: false,
    hostReady: true,
    handlingHostFailure: false,
    exitCode: 0,
    bootstrapHandoff: undefined,
    worker: undefined,
    generation: 0,
    sandboxSources: [],
    phase: "handoff",
    pending: undefined,
    active: undefined,
    pumping: true,
    bootstrapPending: false,
    priority: { start: 0, restart: 1, resume: 2, recover: 3, stop: 4 },
    root: "/owned-project",
    projectId: "owned-project",
    auditBuffer: { stats: () => ({}) },
    auditSink: { stats: () => ({}) },
    createAuditDeadline: () => deadline,
    supervisedIpc: false,
    invalidMessages: 0,
    lastAudit: undefined,
    lastAuditPermit: undefined,
    lastWindowsTransport: undefined,
    lastWindowsCanonical: undefined,
    lastBrokerTransport: undefined,
    recovery: { tripped: false, failures: [] },
    logAvailable: true,
    console: { error() {} },
    redact: value => value,
    saveRecovery() {
      steps.push("save-recovery")
    },
    record(type, details) {
      records.push({ type, details })
    },
    recordAuditCoverage() {},
    authorizeHostEvent: (_, value) => value,
    auditEvent: value => value,
    buildLinuxSandbox: () => spec,
    pipeHostOutput: () => async () => {},
    spawn() {
      steps.push("spawn")
      if (options.spawnError) throw options.spawnError
      return child
    },
    spawnWindowsSandbox() {
      steps.push("spawn-windows")
      return child
    },
    prepareDescendantCapture(original) {
      assert.equal(original, child)
      steps.push("pin-original")
    },
    async captureDescendants(original) {
      assert.equal(original, child)
      steps.push("capture")
      if (options.captureError) throw options.captureError
      return []
    },
    retireDescendantCapture(original) {
      assert.equal(original, child)
      steps.push("retire")
    },
    async terminateWorkerTree(original) {
      assert.equal(original, child)
      steps.push("terminate-original")
      if (options.terminateError) throw options.terminateError
      child.exitCode = 0
    },
    hasExited: original => original.exitCode !== null || original.signalCode !== null,
    onMessage() {},
    async until(predicate) {
      assert.equal(predicate(), true)
    },
    async sleep() {
      throw new Error("No real timer in ownership component")
    },
    pump() {
      throw new Error("No lifecycle dispatcher in ownership component")
    },
    bootstrapAbort: { abort() {} },
  }
  const api = evaluate(
    path.join(build, "host/supervisor.js"),
    [
      "startWorker",
      "stopWorker",
      "send",
      "fail",
      "trip",
      "enqueue",
      "closeHost",
      "pump",
      "handleHostFailure",
    ],
    bindings,
  )
  return { ...api, steps, records, auditDrops, exits, child, broker }
}

test("broker drop keeps channel identity and does not count write errors twice", async () => {
  const primary = new Error("listen-failure")
  const f = fixture({ listenError: primary })
  await assert.rejects(f.startWorker(), error => error === primary)
  f.broker.auditCallbacks.onDrop({
    key: "actual-channel",
    counters: { received: 1, unknown: 2, invalidFrames: 1, sendErrors: 2 },
  })
  assert.deepEqual(f.auditDrops, [["broker:actual-channel", 3]])
})

test("startup listen failure closes the broker before any spawn and retains both errors", async () => {
  const primary = new Error("listen-failure"),
    cleanup = new Error("broker-close-failure")
  const f = fixture({ listenError: primary, brokerCloseError: cleanup })
  await assert.rejects(f.startWorker(), error => {
    assert.deepEqual([...error.errors], [primary, cleanup])
    return true
  })
  assert.deepEqual(f.steps, ["listen", "broker-close"])
  assert.equal(f.context.worker, undefined)
})

test("spawn failure and launch-FD release failure are both retained without an invented child", async () => {
  const primary = new Error("spawn-failure"),
    release = new Error("release-failure")
  const f = fixture({ spawnError: primary, releaseError: release })
  await assert.rejects(f.startWorker(), error => {
    assert.deepEqual([...error.errors], [primary, release])
    return true
  })
  assert.deepEqual(f.steps, ["listen", "spawn", "release-launch-fds", "broker-close"])
  assert.equal(f.context.worker, undefined)
})

test("a child is owned before observe/release failure and its early error cannot escape", async () => {
  const primary = new Error("observe-failure"),
    release = new Error("release-failure")
  const f = fixture({ observeError: primary, releaseError: release, emitEarlyError: true })
  await assert.rejects(f.startWorker(), error => {
    assert.deepEqual([...error.errors], [primary, release])
    return true
  })
  assert.equal(f.context.worker, undefined)
  f.child.emit("error", new Error("later-owned-child-error"))
  f.child.emit("close", 0, null)
  assert.equal(f.records.filter(row => row.type === "worker-error").length, 2)
  assert.equal(f.records.filter(row => row.type === "worker-close").length, 1)
  for (const stage of ["broker-close", "terminate-original", "scope-wait", "audit-flush"])
    assert.ok(f.steps.includes(stage), stage)
  assert.ok(f.steps.indexOf("retire") < f.steps.indexOf("terminate-original"))
})

test("cleanup failures retain provisional ownership while every other owned resource is attempted", async () => {
  const f = fixture({
    observeError: new Error("observe-failure"),
    brokerCloseError: new Error("broker-close-failure"),
    terminateError: new Error("original-exit-unconfirmed"),
    scopeWaitError: new Error("scope-unconfirmed"),
    keepAlive: true,
  })
  await assert.rejects(f.startWorker(), error => {
    assert.equal(error.errors[0].message, "observe-failure")
    assert.equal(error.errors[1].errors.length, 3)
    return true
  })
  assert.equal(f.context.worker.child, f.child)
  assert.equal(f.context.worker.expectedExit, true)
  for (const stage of ["broker-close", "terminate-original", "scope-wait", "audit-flush"])
    assert.ok(f.steps.includes(stage), stage)
  await assert.rejects(f.startWorker(), /上一工作进程尚未清理/)
  assert.equal(f.steps.filter(stage => stage === "spawn").length, 1)
})

test("Windows scope disposer is owned before native runtime listener setup can fail", async () => {
  const f = fixture({ platform: "win32", windowsSetupError: true })
  await assert.rejects(f.startWorker(), /windows-setup-failure/)
  assert.equal(f.context.worker, undefined)
  assert.ok(f.steps.includes("dispose-scope"))
  assert.ok(f.steps.includes("terminate-original"))
})

test("unknown Windows Host profile is refused before broker listen or business spawn", async () => {
  const primary = new Error("UNSUPPORTED_NODE_PROFILE")
  const f = fixture({ platform: "win32", mode: "managed", preflightError: primary })
  await assert.rejects(f.startWorker(), error => error === primary)
  assert.deepEqual(f.steps, ["runtime-preflight"])
  assert.equal(f.context.generation, 0)
})

test("fresh capture failure cannot skip original cleanup or clear an uncertain Windows session", async () => {
  const f = fixture({
    platform: "win32",
    mode: "managed",
    captureError: new Error("capture-incomplete"),
  })
  f.context.until = async () => {
    throw new Error("startup-timeout")
  }
  await f.startWorker()
  await assert.rejects(f.stopWorker(), /拒绝替换/)
  assert.ok(f.steps.indexOf("pin-original") < f.steps.indexOf("capture"))
  assert.ok(f.steps.includes("terminate-original"))
  assert.ok(f.steps.includes("audit-flush"))
  assert.equal(f.context.worker.child, f.child)
})

test("trip removes a queued recovery while preserving an explicit stop request", () => {
  const f = fixture()
  f.context.pending = { type: "recover", reason: "earlier-error" }
  f.trip("cleanup-unconfirmed")
  assert.equal(f.context.pending, undefined)
  f.enqueue({ type: "start" })
  f.enqueue({ type: "restart" })
  f.enqueue({ type: "recover" })
  assert.equal(f.context.pending, undefined)
  f.context.pending = { type: "stop" }
  f.trip("still-unconfirmed")
  assert.equal(f.context.pending.type, "stop")
  assert.equal(f.steps.includes("spawn"), false)
})

test("fatal host cleanup failure retains worker ownership instead of forcing host exit", async () => {
  const f = fixture({ terminateError: new Error("original-exit-unconfirmed"), keepAlive: true })
  await f.startWorker()
  f.handleHostFailure("uncaught-exception", new Error("host-failed"))
  f.handleHostFailure("unhandled-rejection", new Error("reentrant-failure"))
  assert.equal(f.context.pending.type, "stop")
  await f.pump()
  assert.equal(f.context.phase, "tripped")
  assert.equal(f.context.recovery.reason, "stop-cleanup-failed")
  assert.equal(f.context.worker.child, f.child)
  assert.equal(f.context.exitCode, 1)
  assert.deepEqual(f.exits, [])
  assert.equal(f.records.filter(row => row.type === "host-uncaught-exception").length, 1)
  assert.equal(f.records.filter(row => row.type === "host-unhandled-rejection").length, 0)
  assert.ok(f.steps.includes("terminate-original"))
})

test("failed candidate cleanup retains its session snapshot while resume restores the previous configuration", async () => {
  const file = path.join(build, "host/supervisor.js")
  const parsed = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  )
  const declaration = parsed.statements
    .filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .find(item => ts.isIdentifier(item.name) && item.name.text === "configuration")
  assert.ok(declaration?.initializer)
  const previous = { id: "previous", isolationMode: "managed" }
  const candidate = { id: "candidate", isolationMode: "os-sandbox" }
  const previousSources = [{ id: "previous-source" }]
  const candidateSources = [{ id: "candidate-source" }]
  const started = [],
    closed = []
  let operations, api
  api = evaluate(file, ["pump"], {
    SettingsController: class {
      constructor(_settings, actions) {
        operations = actions
      }
      hasPending = false
    },
    settings: previous,
    sandboxSources: previousSources,
    worker: { settings: previous, sources: previousSources, online: true },
    stopping: false,
    recovery: { tripped: false, failures: [] },
    pumping: false,
    active: undefined,
    pending: undefined,
    record() {},
    saveRecovery() {},
    trip() {
      api.context.recovery.tripped = true
    },
    async startWorker() {
      const session = {
        settings: api.context.settings,
        sources: api.context.sandboxSources,
        online: api.context.settings !== candidate,
        ...(api.context.settings === candidate ? { failure: "candidate-startup-failed" } : {}),
      }
      started.push(session)
      api.context.worker = session
    },
    async stopWorker() {
      const session = api.context.worker
      closed.push(session)
      if (closed.length === 2) throw new Error("candidate-cleanup-unconfirmed")
      api.context.worker = undefined
    },
  })
  new vm.Script(
    `globalThis.configuration = ${declaration.initializer.getText(parsed)}`,
  ).runInContext(api.context)
  await assert.rejects(
    operations.reload(candidate, candidateSources),
    error =>
      error.errors?.[0]?.message === "candidate-startup-failed" &&
      error.errors?.[1]?.message === "candidate-cleanup-unconfirmed",
  )
  assert.equal(api.context.settings, previous)
  assert.equal(api.context.sandboxSources, previousSources)
  assert.equal(api.context.worker, started[0])
  assert.equal(closed[1].settings, candidate)
  assert.equal(closed[1].sources, candidateSources)
  assert.equal(api.context.recovery.tripped, true)
  api.context.pending = { type: "resume" }
  await api.pump()
  assert.equal(closed[2], started[0])
  assert.equal(started[1].settings, previous)
  assert.equal(started[1].sources, previousSources)
  assert.equal(api.context.recovery.tripped, false)
})

test("actual Host preflight checks platform, architecture, version and exact image without touching children", () => {
  const file = path.join(build, "native-process/index.js")
  const digest = "d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5"
  for (const change of [
    { platform: "linux" },
    { arch: "arm64" },
    { version: "v24.22.2" },
    { sha: "0".repeat(64) },
    {},
  ]) {
    let hashes = 0
    const api = evaluate(file, ["assertOriginalWindowsChildProbeRuntime"], {
      process: {
        platform: "win32",
        arch: "x64",
        version: "v24.22.1",
        execPath: "owned-node",
        ...change,
      },
      qualifiedProbeImage: digest,
      probeRuntimeQualified: undefined,
      hashFile() {
        hashes++
        return change.sha ?? digest
      },
      fail(code, outcome) {
        const error = new Error(code)
        error.outcome = outcome
        throw error
      },
    })
    if (Object.keys(change).length)
      assert.throws(
        api.assertOriginalWindowsChildProbeRuntime,
        error =>
          error.message === "UNSUPPORTED_NODE_PROFILE" && error.outcome === "refused-before-action",
      )
    else {
      api.assertOriginalWindowsChildProbeRuntime()
      api.assertOriginalWindowsChildProbeRuntime()
      assert.equal(hashes, 1)
    }
  }
})
