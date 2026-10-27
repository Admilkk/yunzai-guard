import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import daemon from "./pm2-cached-upgrade-daemon.cjs"
import {
  assertUpgradeReceipt,
  admitOwnedScope,
  classifyPrivateDaemon,
  summarizeDeclaredLogs,
  stopWithIndependentCensus,
  privateAppDeclaration,
  powershellUtf8,
  observeOriginalExits,
  observeBoundScope,
} from "./pm2-cached-upgrade-fixture.mjs"
import { snapshot, stopAfterCensus } from "./environment-fixture.mjs"

const { channel, validateRequest, createController } = daemon
const symbols = {
  legacy: Symbol.for("yunzai-guard.pm2-daemon.v1"),
  fresh: Symbol.for("yunzai-guard.pm2-daemon.resource.v1"),
  compat: Symbol.for("yunzai-guard.pm2-compat.v1"),
  resource: Symbol.for("yunzai-guard.pm2-compat.resource.v1"),
}
const command = overrides => ({
  channel,
  nonce: "own-nonce",
  id: 1,
  command: "health",
  ...overrides,
})
function fixture() {
  const config = {
    peer: { id: 0, agent: "old-peer-agent", root: "old-root", launcher: "old-launcher" },
    target: {
      id: 2,
      stable: "target-stable",
      fresh: "target-fresh",
      root: "new-root",
      launcher: "new-launcher",
    },
    pm2Root: "fixed-pm2",
    hotNonce: "own-hot-nonce",
    startupTimeout: 45000,
    shutdownTimeout: 1500,
  }
  const original = { forkMode() {}, processIsDead() {}, handleExit() {}, restartProcessId() {} }
  const oldPeer = { root: "old-root", uniqueId: "old-identity" }
  const map = new Map([[0, oldPeer]])
  const god = {
    ...original,
    clusters_db: {
      0: { pid: 1001, exitCode: null, signalCode: null, pm2_env: { unique_id: "old-identity" } },
      2: { pid: 1002, pm2_env: { unique_id: "new-identity" } },
    },
  }
  const legacy = { applications: map, forkMode: original.forkMode }
  const compatibility = { processIsDead: original.processIsDead, handleExit: original.handleExit }
  god[symbols.legacy] = legacy
  god[symbols.compat] = compatibility
  const calls = [],
    cacheReads = [],
    cache = new Map()
  const peerNamespace = {
    registerPm2ApplicationWithGod(current, options, context) {
      calls.push({ current, options, context })
      assert.equal(current, god)
      assert.equal(options.pmId, 0)
      assert.equal(options.pid, 1001)
      assert.equal(options.root, config.peer.root)
      assert.equal(options.nonce, config.hotNonce)
      assert.equal(options.requestRestart, false)
      map.set(0, { ...oldPeer, refreshedByOwnHotCall: true })
      return { requiresHandoff: false }
    },
  }
  const primedNamespace = {}
  cache.set(config.peer.agent, peerNamespace)
  const controller = createController(config, {
    god: () => god,
    cached: key => {
      cacheReads.push(key)
      return cache.get(key)
    },
    prime: key => {
      calls.push({ prime: key })
      cache.set(key, primedNamespace)
      return primedNamespace
    },
    inspectorUrl: () => "ws://127.0.0.1:12345/test-only",
    environmentDigest: () => "fixed-environment",
    report: () => {},
  })
  function installCandidate() {
    god[symbols.fresh] = {
      applications: new Map([
        [
          2,
          {
            root: config.target.root,
            uniqueId: "new-identity",
            launcherPath: config.target.launcher,
          },
        ],
      ]),
      originalForkMode: original.forkMode,
    }
    god[symbols.resource] = {
      originalProcessIsDead: original.processIsDead,
      originalHandleExit: original.handleExit,
    }
    god.forkMode = () => {}
    god.processIsDead = () => {}
    god.handleExit = () => {}
    legacy.forkMode = god.forkMode
    compatibility.processIsDead = god.processIsDead
    compatibility.handleExit = god.handleExit
    cache.set(config.target.fresh, {
      pm2AgentCapabilities: { agentProtocol: 2, bootstrapExitBarrier: 1, cachedRegistryUpgrade: 1 },
    })
  }
  return {
    controller,
    config,
    god,
    map,
    legacy,
    original,
    calls,
    cacheReads,
    cache,
    peerNamespace,
    primedNamespace,
    installCandidate,
  }
}
test("closed IPC refuses wrong nonce, arbitrary arguments, unknown commands and unsafe objects", () => {
  assert.equal(validateRequest(command(), "own-nonce"), true)
  for (const value of [
    command({ nonce: "other" }),
    command({ command: "eval" }),
    command({ file: "arbitrary" }),
    command({ id: 0 }),
    Object.assign(Object.create(null), command()),
  ])
    assert.equal(validateRequest(value, "own-nonce"), false)
  let invoked = 0
  const accessor = {
    ...command(),
    get command() {
      invoked++
      throw Error("must not execute")
    },
  }
  assert.equal(validateRequest(accessor, "own-nonce"), false)
  assert.equal(
    validateRequest(
      new Proxy(command(), {
        getPrototypeOf() {
          invoked++
          throw Error("must not execute")
        },
      }),
      "own-nonce",
    ),
    false,
  )
  assert.equal(validateRequest({ ...command(), [Symbol("extra")]: true }, "own-nonce"), false)
  assert.equal(invoked, 0)
})
test("capture and prime preserve real refs and query cannot cause the fresh agent to load", async () => {
  const value = fixture()
  await assert.rejects(value.controller("query"), /capture|required/i)
  const capture = await value.controller("capture-old")
  assert.deepEqual(capture.legacyIds, [0])
  assert.equal(capture.restartMethodCaptured, true)
  const prime = await value.controller("prime-target")
  assert.equal(prime.registryAndMethodsUnchanged, true)
  assert.equal(prime.restartMethodUnchanged, true)
  const beforeCalls = value.calls.length
  const receipt = await value.controller("query")
  assert.equal(receipt.freshNamespaceActuallyLoaded, false)
  assert.equal(value.calls.length, beforeCalls)
  assert.equal(value.cache.has(value.config.target.fresh), false)
  assert.ok(value.cacheReads.includes(value.config.target.fresh))
  await assert.rejects(value.controller("prime-target"), /already primed/)
  value.installCandidate()
  assertUpgradeReceipt(await value.controller("query"))
})
test("only the actual old namespace hot call may refresh its own slot, once, without method replacement", async () => {
  const value = fixture()
  await value.controller("capture-old")
  await value.controller("prime-target")
  value.installCandidate()
  const ownMap = value.map,
    previousPeer = value.map.get(0)
  const hot = await value.controller("hot-register-old")
  assert.equal(value.map, ownMap)
  assert.notEqual(value.map.get(0), previousPeer)
  assert.equal(hot.refreshedOwnApplication, true)
  assert.equal(hot.methodsUnchanged, true)
  assert.equal(hot.result.requiresHandoff, false)
  assertUpgradeReceipt(hot.receipt, { afterHot: true })
  assert.equal(value.calls.filter(row => row.options).length, 1)
  await assert.rejects(value.controller("hot-register-old"), /once only/)
})
test("receipt exposes an unrelated restart method change and refuses changed peer ownership", async () => {
  const value = fixture()
  await value.controller("capture-old")
  await value.controller("prime-target")
  value.installCandidate()
  value.god.restartProcessId = () => {}
  const receipt = await value.controller("query")
  assert.equal(receipt.restartMethodUnchanged, false)
  assert.throws(() => assertUpgradeReceipt(receipt), /restartMethodUnchanged/)
  value.map.set(0, { unexpected: true })
  await assert.rejects(value.controller("hot-register-old"), /owner changed/)
})
test("capture never executes an accessor collection or accepts a Proxy Map", async () => {
  const accessor = fixture()
  let invoked = 0
  Object.defineProperty(accessor.legacy, "applications", {
    get() {
      invoked++
      throw Error("must not execute")
    },
  })
  await assert.rejects(accessor.controller("capture-old"), /native Map/)
  const proxy = fixture()
  proxy.legacy.applications = new Proxy(proxy.map, {
    getPrototypeOf() {
      invoked++
      throw Error("must not execute")
    },
  })
  await assert.rejects(proxy.controller("capture-old"), /native Map/)
  assert.equal(invoked, 0)
})
test("hot registration rejects a daemon method mutation and does not fabricate a passing receipt", async () => {
  const value = fixture()
  await value.controller("capture-old")
  await value.controller("prime-target")
  value.installCandidate()
  value.peerNamespace.registerPm2ApplicationWithGod = god => {
    god.restartProcessId = () => {}
    return { requiresHandoff: false }
  }
  await assert.rejects(value.controller("hot-register-old"), /changed a daemon lifecycle method/)
  assert.equal((await value.controller("query")).oldHotRegisterPerformed, false)
})
function admission() {
  const daemon = { pid: 100, parent: 10, start: "1000" },
    root = { pid: 200, parent: 100, start: "2000" },
    worker = { pid: 201, parent: 200, start: "3000" }
  return {
    rows: [root, worker],
    physical: [{ ...root }, { ...worker }],
    expectedRoot: root,
    expectedDaemon: daemon,
    rootBefore: root,
    rootAfter: root,
    daemonBefore: daemon,
    daemonAfter: daemon,
    workerPid: worker.pid,
  }
}
test("scope admission accepts a prebound God root and direct worker only after all native checks", () => {
  const value = admission(),
    ledger = new Map()
  assert.equal(admitOwnedScope(ledger, value).length, 2)
  assert.equal(ledger.size, 2)
  assert.notEqual(ledger.get("200:2000"), value.expectedRoot)
})
test("the actual scope observation entry rejects every bad metadata proof before any native callback", () => {
  for (const mutate of [
    value => {
      value.daemonBefore = { ...value.expectedDaemon, start: "1100" }
    },
    value => {
      value.rootBefore = { ...value.expectedRoot, start: "2100" }
    },
    value => {
      value.rows[0] = { ...value.rows[0], start: "2100" }
    },
    value => {
      value.rows[0] = { ...value.rows[0], parent: 999 }
    },
    value => {
      value.rows[1] = { ...value.rows[1], start: "1000" }
    },
    value => {
      value.rows[1] = { ...value.rows[1], start: null }
    },
    value => {
      value.rows.push({ ...value.rows[0] })
    },
    value => {
      value.workerPid = 202
      value.rows.push({ pid: 202, parent: 201, start: "4000" })
    },
    value => {
      value.rows.push({ pid: 999, parent: 888, start: "4000" })
    },
  ]) {
    const value = admission(),
      ledger = new Map()
    let callbacks = 0
    mutate(value)
    assert.throws(() => {
      value.physical = observeBoundScope(value, row => {
        callbacks++
        return { ...row }
      })
      admitOwnedScope(ledger, value)
    })
    assert.equal(callbacks, 0)
    assert.equal(ledger.size, 0)
  }
})
test("post-observation identity change still rejects the atomic ledger commit", () => {
  const value = admission(),
    ledger = new Map()
  let callbacks = 0
  value.physical = observeBoundScope(value, row => {
    callbacks++
    value.rootAfter = { ...value.expectedRoot, start: "2200" }
    return { ...row }
  })
  assert.equal(callbacks, 2)
  assert.throws(() => admitOwnedScope(ledger, value), /Expected root birth changed/)
  assert.equal(ledger.size, 0)
})
test("wrong or reused numeric roots and unrelated trees never enter the reclaim ledger", () => {
  for (const mutate of [
    value => {
      value.rootBefore = { ...value.expectedRoot, start: "reused-pid" }
    },
    value => {
      value.rows = [
        { ...value.expectedRoot, parent: 999 },
        { pid: 300, parent: 200, start: "foreign-child" },
      ]
    },
    value => {
      value.daemonAfter = { ...value.expectedDaemon, start: "replaced-daemon" }
    },
    value => {
      value.rows.push({ pid: 500, parent: 999, start: "5000" })
      value.physical.push(value.rows.at(-1))
    },
    value => {
      value.physical[1] = { ...value.physical[1], start: "reused-worker" }
    },
  ]) {
    const value = admission(),
      ledger = new Map()
    mutate(value)
    assert.throws(() => admitOwnedScope(ledger, value))
    assert.equal(ledger.size, 0)
    assert.equal([...ledger.values()].length, 0, "Failed ownership gives reclaim zero candidates")
  }
})
test("bad worker ancestry, duplicate process rows and changed precise births leave admission atomic", () => {
  for (const mutate of [
    value => {
      const grandchild = { pid: 202, parent: 201, start: "4000" }
      value.rows.push(grandchild)
      value.physical.push(grandchild)
      value.workerPid = 202
    },
    value => value.rows.push({ ...value.rows[0] }),
    value => {
      value.expectedRoot = { ...value.expectedRoot, ticks: "exact-original" }
      value.physical[0].ticks = "different-birth"
    },
  ]) {
    const value = admission(),
      ledger = new Map()
    mutate(value)
    assert.throws(() => admitOwnedScope(ledger, value))
    assert.equal(ledger.size, 0)
  }
})
test("a replacement private daemon or unknown pid file cannot become confirmed cleanup", () => {
  const original = { pid: 100, parent: 10, start: "1000" }
  assert.equal(
    classifyPrivateDaemon(original, { present: true, pid: 100, current: original }).status,
    "original-live",
  )
  for (const current of [
    { ...original, start: "2000" },
    { pid: 101, parent: 20, start: "3000" },
  ]) {
    const state = classifyPrivateDaemon(original, { present: true, pid: current.pid, current })
    assert.equal(state.status, "replacement-live")
    assert.notEqual(state.status, "none-live", "Replacement must hold subsequent cases")
  }
  assert.equal(classifyPrivateDaemon(original, { present: true, pid: NaN }).status, "unknown")
  assert.equal(
    classifyPrivateDaemon(original, { error: "identity-permission-denied" }).status,
    "unknown",
  )
  assert.equal(classifyPrivateDaemon(original, { present: false }).status, "none-live")
  assert.equal(classifyPrivateDaemon(original, { present: true, pid: 100 }).status, "none-live")
  assert.equal(
    classifyPrivateDaemon(original, {
      present: true,
      pid: 100,
      current: { ...original, start: null },
    }).status,
    "unknown",
  )
})
test("exit receipts keep unknown identities unresolved and distinguish reparenting from PID reuse", () => {
  const expected = { pid: 100, parent: 10, start: "1000" }
  const read = lookup => observeOriginalExits([expected], lookup)[0]
  assert.equal(read(() => undefined).originalExited, true)
  assert.equal(read(() => ({ ...expected, start: "2000" })).originalExited, true)
  assert.equal(read(() => ({ ...expected, parent: 1 })).originalExited, false)
  for (const lookup of [
    () => ({ ...expected, start: null }),
    () => {
      throw Error("injected identity lookup failure")
    },
    () => ({ ...expected, pid: 101 }),
  ]) {
    const receipt = read(lookup)
    assert.equal(receipt.originalExited, false)
    assert.equal(receipt.status, "unknown")
  }
})
function logs() {
  const targetHosts = Array.from({ length: 21 }, (_, index) => 100 + index)
  return {
    targetHosts,
    peerHosts: [10, 11, 12],
    errorTexts: [
      { name: "old", text: "" },
      { name: "new", text: "" },
    ],
    daemonText: targetHosts
      .map(pid => "[Yunzai Guard PM2] " + JSON.stringify({ event: "pm2-log-drained", pid }))
      .join("\n"),
  }
}
test("complete log scan retains an early error hidden by a whitespace-only display tail", () => {
  const value = logs()
  value.errorTexts[1].text = "early-application-error\n" + " ".repeat(20000)
  value.daemonText = "ERR_STREAM_DESTROYED: write\n" + value.daemonText + "\n".repeat(17000)
  const result = summarizeDeclaredLogs(value)
  assert.equal(result.declaredLogChecksClear, false)
  assert.equal(result.logFiles.errors[1].stderrTail.trim(), "")
  assert.equal(result.logFiles.errors[1].bytes, Buffer.byteLength(value.errorTexts[1].text))
  assert.equal(result.rawDaemonStreamErrors.length, 1)
  assert.match(result.logFiles.errors[1].sha256, /^[a-f0-9]{64}$/)
  assert.equal(result.targetLogGateCoverage.exactlyOnePerHost, true)
})
test("PID aliases or missing/duplicate gate receipts cannot fold into successful twenty-one-host coverage", () => {
  const value = logs()
  assert.equal(summarizeDeclaredLogs(value).targetLogGateCoverage.exactlyOnePerHost, true)
  assert.throws(
    () =>
      summarizeDeclaredLogs({ ...value, targetHosts: [...value.targetHosts.slice(0, 20), 100] }),
    /Repeated target/,
  )
  assert.throws(() => summarizeDeclaredLogs({ ...value, peerHosts: [100] }), /overlap/)
  assert.throws(() => summarizeDeclaredLogs({ ...value, peerHosts: [10, 10] }), /Repeated peer/)
  assert.equal(
    summarizeDeclaredLogs({
      ...value,
      daemonText:
        value.daemonText +
        "\n[Yunzai Guard PM2] " +
        JSON.stringify({ event: "pm2-log-drained", pid: 100 }),
    }).targetLogGateCoverage.exactlyOnePerHost,
    false,
  )
  assert.equal(
    summarizeDeclaredLogs({ ...value, targetHosts: value.targetHosts.slice(1) })
      .targetLogGateCoverage.exactlyOnePerHost,
    false,
  )
})
test("closed God slot binding rejects wrong application metadata before observing a native PID", async () => {
  const child = {
    pid: 200,
    exitCode: null,
    signalCode: null,
    pm2_env: { pm_id: 0, unique_id: "own-app", pm_exec_path: "own-launcher", pm_cwd: "own-root" },
  }
  const config = { peer: { id: 0, launcher: "own-launcher", root: "own-root" } }
  let observations = 0
  const controller = createController(config, {
    god: () => ({ clusters_db: { 0: child } }),
    canonical: String,
    observeChild: () => {
      observations++
      return { pid: 200, parent: 100, start: "held-birth" }
    },
    inspectorUrl: () => "own-inspector",
    environmentDigest: () => "own-env",
  })
  assert.equal((await controller("health")).slots[0].identity.start, "held-birth")
  child.pm2_env.pm_exec_path = "foreign-launcher"
  await assert.rejects(controller("health"), /script or cwd/)
  assert.equal(observations, 1, "Wrong God metadata must not bless a sampled native PID")
  child.pm2_env.pm_exec_path = "own-launcher"
  child.pm2_env.pm_id = 99
  await assert.rejects(controller("health"), /configured God slot/)
  assert.equal(observations, 1)
})
test("admission itself refuses the real stale-parent counterexample even if native details are readable", () => {
  const daemon = { pid: 58464, parent: 32868, start: "20261024160356780" }
  const rows = [
    { pid: 15228, parent: 58464, start: "20261024160507301" },
    { pid: 49564, parent: 15228, start: "20261024160507416" },
    { pid: 1228, parent: 49564, start: "20261024113013592" },
    { pid: 1244, parent: 1228, start: "20261022000742768" },
  ]
  const ledger = new Map()
  assert.throws(
    () =>
      admitOwnedScope(ledger, {
        rows,
        physical: rows.map(row => ({ ...row })),
        expectedRoot: rows[0],
        expectedDaemon: daemon,
        rootBefore: rows[0],
        rootAfter: rows[0],
        daemonBefore: daemon,
        daemonAfter: daemon,
        workerPid: 49564,
      }),
    /Child birth precedes/,
  )
  assert.equal(ledger.size, 0)
  assert.equal([...ledger.values()].length, 0, "Rejected old branches give reclaim zero candidates")
})
test("admission rejects unknown births atomically while equal coarse timestamps remain legal", () => {
  const unknown = admission(),
    ledger = new Map()
  unknown.rows[1] = { ...unknown.rows[1], start: "unknown" }
  unknown.physical[1] = { ...unknown.rows[1] }
  assert.throws(() => admitOwnedScope(ledger, unknown))
  assert.equal(ledger.size, 0)
  const equal = admission()
  equal.rows[1] = { ...equal.rows[1], start: "2000" }
  equal.physical[1] = { ...equal.rows[1] }
  assert.equal(admitOwnedScope(new Map(), equal).length, 2)
})
test("a failed fresh census cannot suppress exactly one independently proven original private stop", async () => {
  const original = { pid: 100, parent: 10, start: "1000" }
  let proofs = 0,
    stops = 0
  const result = await stopWithIndependentCensus({
    prove: () => {
      proofs++
      return {
        original,
        current: { ...original },
        privateState: { status: "original-live", identity: { ...original } },
      }
    },
    census: () => {
      throw Error("injected unrelated census failure")
    },
    stop: () => {
      stops++
    },
  })
  assert.equal(proofs, 2)
  assert.equal(stops, 1)
  assert.match(result.censusError, /injected unrelated census failure/)
})
test("the first census error is recorded before a second proof or the only stop can also fail", async () => {
  const original = { pid: 100, parent: 10, start: "1000" }
  for (const failureAt of ["prove", "stop"]) {
    const diagnostics = []
    let proofs = 0,
      stops = 0
    await assert.rejects(
      stopWithIndependentCensus({
        prove: () => {
          proofs++
          if (proofs === 2) {
            assert.equal(diagnostics.length, 1)
            if (failureAt === "prove") throw Error("second proof failed")
          }
          return {
            original,
            current: { ...original },
            privateState: { status: "original-live", identity: { ...original } },
          }
        },
        census: () => {
          throw Error("first census failed")
        },
        onCensusError: error => diagnostics.push(error),
        stop: () => {
          stops++
          assert.equal(diagnostics.length, 1)
          throw Error("only stop failed after original exit")
        },
      }),
      error => {
        assert.match(error.censusError, /first census failed/)
        assert.match(
          error.controlError,
          failureAt === "prove" ? /second proof failed/ : /only stop failed/,
        )
        return true
      },
    )
    assert.equal(proofs, 2)
    assert.equal(stops, failureAt === "prove" ? 0 : 1)
    assert.equal(diagnostics.length, 1)
  }
})
test("a common strict unknown census still permits the separately proven private control stop once", async () => {
  const errors = [],
    root = { pid: 100, parent: 10, start: "1000" }
  let stops = 0
  const result = await stopAfterCensus({
    prove: () => {},
    census: () => snapshot(100, [root, { pid: 101, parent: 100, start: null }]),
    onCensusError: error => errors.push(error),
    stop: () => {
      stops++
      assert.equal(errors.length, 1)
    },
  })
  assert.equal(stops, 1)
  assert.equal(errors.length, 1)
  assert.match(result.censusError, /related-child-unknown/)
  assert.equal(errors.length === 0, false, "Known stop success never makes this census complete")
})
test("unknown or replaced private proof permits no stop, including a change after census", async () => {
  const original = { pid: 100, parent: 10, start: "1000" }
  for (const kind of ["unknown", "replacement", "changed-after-census", "unknown-birth"]) {
    let proofs = 0,
      stops = 0
    await assert.rejects(
      stopWithIndependentCensus({
        prove: () => {
          proofs++
          const value = {
            original,
            current: { ...original },
            privateState: { status: "original-live", identity: { ...original } },
          }
          if (kind === "unknown") value.privateState.status = "unknown"
          if (kind === "replacement" || (kind === "changed-after-census" && proofs === 2))
            value.current.start = "2000"
          if (kind === "unknown-birth") {
            value.original = { ...original, start: "unknown" }
            value.current = { ...value.original }
            value.privateState.identity = { ...value.original }
          }
          return value
        },
        census: () => {},
        stop: () => {
          stops++
        },
      }),
      /not independently proven/,
    )
    assert.equal(stops, 0)
  }
})
test("all three app declarations exclude inherited CLI transport options without a Guard preload", () => {
  for (const name of ["guard-old-peer", "guard-new-target", "guard-unrelated"]) {
    const input = {
      name,
      script: "original-app.js",
      interpreter: "/pinned/node",
      env: { FIXTURE_CANARY: "same" },
    }
    const generated = privateAppDeclaration(input)
    const app = JSON.parse(generated.slice("module.exports=".length)).apps[0]
    assert.deepEqual(app.filter_env, ["NODE_OPTIONS", "PM2_NODE_OPTIONS"])
    assert.deepEqual(app.env, input.env)
    assert.equal(Object.hasOwn(input, "filter_env"), false)
    assert.equal(Object.hasOwn(app.env, "NODE_OPTIONS"), false)
    assert.equal(Object.hasOwn(app.env, "PM2_NODE_OPTIONS"), false)
    assert.equal(Object.hasOwn(app, "node_args"), false)
  }
})
test(
  "self-authored Windows PowerShell diagnostic errors retain exact UTF8 text",
  { skip: process.platform !== "win32" },
  () => {
    assert.throws(
      () =>
        execFileSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", powershellUtf8 + "throw '出生时间不可用'"],
          {
            encoding: "utf8",
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 10000,
          },
        ),
      error => {
        assert.equal(error.status, 1)
        assert.ok(error.stderr.includes("出生时间不可用"))
        assert.equal(error.stderr.includes("\ufffd"), false)
        return true
      },
    )
  },
)
