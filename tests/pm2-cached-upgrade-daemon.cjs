const fs = require("node:fs")
const path = require("node:path")
const inspector = require("node:inspector")
const { createRequire } = require("node:module")
const { createHash } = require("node:crypto")
const { types } = require("node:util")
const { ChildProcess, execFileSync } = require("node:child_process")
const channel = "guard-cached-upgrade-fixture-v1"
const commands = new Set(["health", "capture-old", "prime-target", "query", "hot-register-old"])
const own = (object, key) => {
  if (
    !object ||
    (typeof object !== "object" && typeof object !== "function") ||
    types.isProxy(object)
  )
    return undefined
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  return descriptor && "value" in descriptor ? descriptor.value : undefined
}
function validateRequest(value, nonce) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !types.isProxy(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    own(value, "channel") === channel &&
    own(value, "nonce") === nonce &&
    Number.isSafeInteger(own(value, "id")) &&
    own(value, "id") > 0 &&
    commands.has(own(value, "command")) &&
    Reflect.ownKeys(value).every(key => ["channel", "nonce", "id", "command"].includes(key)),
  )
}
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const environmentDigest = () =>
  digest(
    Object.fromEntries(
      Object.keys(process.env)
        .sort()
        .map(k => [k, process.env[k]]),
    ),
  )
function nativeMap(value) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Map.prototype)
    throw new Error("Fixture expected a native Map")
  return value
}
const get = (map, key) => Map.prototype.get.call(nativeMap(map), key)
const keys = map => [...Map.prototype.keys.call(nativeMap(map))].sort((a, b) => a - b)
const symbols = {
  legacy: Symbol.for("yunzai-guard.pm2-daemon.v1"),
  fresh: Symbol.for("yunzai-guard.pm2-daemon.resource.v1"),
  compat: Symbol.for("yunzai-guard.pm2-compat.v1"),
  resource: Symbol.for("yunzai-guard.pm2-compat.resource.v1"),
}
/** 仅接受封闭的测试命令，不能在请求中传入路径、JavaScript 或 PM2 操作。 */
function createController(config, dependencies) {
  let held,
    primed,
    hot = false
  const namespace = file => {
    const value = dependencies.cached(file)
    if (!value) throw new Error("Expected namespace was not actually loaded by the real app")
    return value
  }
  const state = () => {
    const god = dependencies.god(),
      legacy = own(god, symbols.legacy)
    return {
      god,
      legacy,
      map: own(legacy, "applications"),
      peer: legacy && get(own(legacy, "applications"), config.peer.id),
      compat: own(god, symbols.compat),
    }
  }
  const methods = god =>
    ["forkMode", "processIsDead", "handleExit", "restartProcessId"].map(k => own(god, k))
  const peerCurrent = god => own(own(god, "clusters_db"), String(config.peer.id))
  const slots = () => {
    const god = dependencies.god(),
      values = []
    for (const spec of [config.peer, config.resident, config.target].filter(Boolean)) {
      const child = own(own(god, "clusters_db"), String(spec.id))
      if (!child) continue
      const env = own(child, "pm2_env"),
        pid = own(child, "pid")
      if (
        !env ||
        own(env, "pm_id") !== spec.id ||
        !Number.isSafeInteger(pid) ||
        pid <= 1 ||
        own(child, "exitCode") !== null ||
        own(child, "signalCode") !== null
      )
        throw new Error("A configured God slot is not a live child")
      const script = own(env, "pm_exec_path"),
        cwd = own(env, "pm_cwd")
      if (
        dependencies.canonical(script) !== dependencies.canonical(spec.launcher || spec.script) ||
        dependencies.canonical(cwd) !== dependencies.canonical(spec.root)
      )
        throw new Error("God slot script or cwd does not match the predeclared application")
      const identity = dependencies.observeChild(child)
      if (
        own(own(god, "clusters_db"), String(spec.id)) !== child ||
        own(child, "exitCode") !== null ||
        own(child, "signalCode") !== null
      )
        throw new Error("God child changed while binding its native birth")
      values.push({ id: spec.id, pid, uniqueId: own(env, "unique_id"), script, cwd, identity })
    }
    return values
  }
  function receipt() {
    if (!held || !primed) throw new Error("Capture and prime must precede receipts")
    const current = state(),
      fresh = own(current.god, symbols.fresh),
      freshMap = own(fresh, "applications")
    const compatibility = own(current.god, symbols.resource)
    const loadedFresh = dependencies.cached(config.target.fresh)
    const caps = own(loadedFresh, "pm2AgentCapabilities")
    const owner = freshMap && get(freshMap, config.target.id)
    const active = own(own(current.god, "clusters_db"), String(config.target.id))
    const environment = own(active, "pm2_env")
    return {
      stableNamespaceStillOld: namespace(config.target.stable) === primed,
      stableCapabilityAbsent: own(primed, "pm2AgentCapabilities") === undefined,
      oldPeerNamespaceStillSame: namespace(config.peer.agent) === held.namespace,
      freshNamespaceActuallyLoaded: Boolean(loadedFresh),
      freshNamespaceDiffers: Boolean(loadedFresh && loadedFresh !== primed),
      freshCapabilities: caps && {
        agentProtocol: own(caps, "agentProtocol"),
        bootstrapExitBarrier: own(caps, "bootstrapExitBarrier"),
        cachedRegistryUpgrade: own(caps, "cachedRegistryUpgrade"),
      },
      legacyRegistrySame: current.legacy === held.legacy,
      legacyMapSame: current.map === held.map,
      legacyPeerApplicationSame: current.peer === held.peer,
      legacyIds: keys(current.map),
      freshIds: freshMap ? keys(freshMap) : [],
      targetAbsentFromLegacy: get(current.map, config.target.id) === undefined,
      freshTargetMatchesActive: Boolean(
        owner &&
        environment &&
        own(owner, "root") === config.target.root &&
        own(owner, "uniqueId") === own(environment, "unique_id") &&
        own(owner, "launcherPath") === config.target.launcher,
      ),
      forkLineageRetained: Boolean(fresh && own(fresh, "originalForkMode") === held.methods[0]),
      compatibilityLineageRetained: Boolean(
        compatibility &&
        own(compatibility, "originalProcessIsDead") === held.methods[1] &&
        own(compatibility, "originalHandleExit") === held.methods[2],
      ),
      legacyMethodSlotsMatchCurrent: Boolean(
        own(current.legacy, "forkMode") === own(current.god, "forkMode") &&
        own(current.compat, "processIsDead") === own(current.god, "processIsDead") &&
        own(current.compat, "handleExit") === own(current.god, "handleExit"),
      ),
      restartMethodUnchanged: own(current.god, "restartProcessId") === held.methods[3],
      oldHotRegisterPerformed: hot,
      inspectorUrl: dependencies.inspectorUrl(),
      environmentDigest: dependencies.environmentDigest(),
      activePendingPreservationClaimed: false,
    }
  }
  return async command => {
    if (!commands.has(command)) throw new Error("Unknown closed fixture command")
    if (command === "health")
      return {
        pid: process.pid,
        inspectorUrl: dependencies.inspectorUrl(),
        environmentDigest: dependencies.environmentDigest(),
        nodeOptionsAbsent: !Object.hasOwn(process.env, "NODE_OPTIONS"),
        pm2NodeOptionsAbsent: !Object.hasOwn(process.env, "PM2_NODE_OPTIONS"),
        slots: slots(),
      }
    if (command === "capture-old") {
      if (held) throw new Error("Old references already captured")
      const current = state()
      if (!current.legacy || !current.peer || own(current.god, symbols.fresh))
        throw new Error("Expected the live old-only registry")
      const peerNamespace = namespace(config.peer.agent)
      if (own(peerNamespace, "pm2AgentCapabilities") !== undefined)
        throw new Error("Historical namespace unexpectedly has new capabilities")
      held = { ...current, namespace: peerNamespace, methods: methods(current.god) }
      return {
        captured: true,
        legacyIds: keys(current.map),
        inspectorUrl: dependencies.inspectorUrl(),
        restartMethodCaptured: typeof held.methods[3] === "function",
        activePendingPreservationClaimed: false,
      }
    }
    if (!held) throw new Error("Old reference capture is required")
    if (command === "prime-target") {
      if (primed) throw new Error("Target namespace already primed")
      const before = state(),
        beforeMethods = methods(before.god)
      primed = dependencies.prime(config.target.stable)
      const after = state()
      if (
        before.legacy !== after.legacy ||
        before.map !== after.map ||
        before.peer !== after.peer ||
        beforeMethods.some((v, i) => v !== methods(after.god)[i]) ||
        own(after.god, symbols.fresh)
      )
        throw new Error("Prime unexpectedly changed registry or methods")
      if (own(primed, "pm2AgentCapabilities") !== undefined)
        throw new Error("Prime did not load exact historical namespace")
      return {
        primed: true,
        registryAndMethodsUnchanged: true,
        restartMethodUnchanged: own(after.god, "restartProcessId") === held.methods[3],
        legacyIds: keys(after.map),
        stableNamespaceHeld: namespace(config.target.stable) === primed,
        stableCapabilityAbsent: true,
      }
    }
    if (command === "query") return receipt()
    if (hot) throw new Error("Old hot registration may run once only")
    const before = receipt()
    if (!before.legacyPeerApplicationSame)
      throw new Error("Old peer owner changed before its own hot call")
    const god = dependencies.god(),
      child = peerCurrent(god),
      beforeMethods = methods(god)
    if (!child || own(child, "exitCode") !== null || own(child, "signalCode") !== null)
      throw new Error("Old hot call requires a live peer")
    const fn = own(held.namespace, "registerPm2ApplicationWithGod")
    if (typeof fn !== "function")
      throw new Error("Actual old namespace is missing its pure function")
    const result = await Reflect.apply(fn, undefined, [
      god,
      {
        pmId: config.peer.id,
        pid: own(child, "pid"),
        root: config.peer.root,
        launcherPath: config.peer.launcher,
        expectedDaemonPid: process.pid,
        pm2Root: config.pm2Root,
        nonce: config.hotNonce,
        requestRestart: false,
        startupTimeout: config.startupTimeout,
        shutdownTimeout: config.shutdownTimeout,
      },
      {
        daemonPid: process.pid,
        report: event => dependencies.report(event),
        inspector: { url: dependencies.inspectorUrl, close: inspector.close },
      },
    ])
    if (result?.requiresHandoff !== false)
      throw new Error("Old hot registration requested an unexpected handoff")
    const current = state()
    if (current.map !== held.map) throw new Error("Old hot call replaced its Map")
    if (beforeMethods.some((value, index) => value !== methods(current.god)[index]))
      throw new Error("Old hot call changed a daemon lifecycle method")
    const refreshedOwnApplication = current.peer !== held.peer
    held.peer = current.peer
    hot = true
    return {
      result,
      refreshedOwnApplication,
      allowedOwnSlotRefresh: true,
      methodsUnchanged: true,
      receipt: receipt(),
    }
  }
}
module.exports = { channel, validateRequest, createController }
if (process.env.GUARD_TEST_PM2_CACHED_UPGRADE_DAEMON === "1") {
  const config = JSON.parse(fs.readFileSync(process.env.GUARD_TEST_PM2_UPGRADE_CONTROL, "utf8"))
  if (
    !/^[a-f0-9]{48}$/.test(config.nonce) ||
    path.resolve(process.env.PM2_HOME || "") !== path.resolve(config.home) ||
    fs.realpathSync.native(process.argv[1]) !==
      fs.realpathSync.native(path.join(config.pm2Root, "lib/Daemon.js"))
  )
    throw new Error("Refusing foreign upgrade fixture role")
  const requireDaemon = createRequire(path.join(config.pm2Root, "lib/Daemon.js"))
  const cached = file => requireDaemon.cache[requireDaemon.resolve(file)]?.exports
  const canonical = file => {
    const result = fs.realpathSync.native(file)
    return process.platform === "win32" ? result.toLowerCase() : result
  }
  const births = new WeakMap()
  const observeChild = child => {
    if (types.isProxy(child) || !(child instanceof ChildProcess))
      throw new Error("God entry is not an actual ChildProcess")
    const pid = own(child, "pid")
    let identity
    if (process.platform === "win32") {
      const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;$p=[Diagnostics.Process]::GetProcessById(${pid});try{$null=$p.Handle;$s=$p.StartTime.ToUniversalTime();$c=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';if($p.HasExited){throw 'Child exited'};@{pid=$p.Id;start=$s.ToString('yyyyMMddHHmmssfff');ticks=$s.Ticks.ToString();parent=[int]$c.ParentProcessId;executable=$c.ExecutablePath}|ConvertTo-Json -Compress}finally{$p.Dispose()}`
      identity = JSON.parse(
        execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 10000,
        }),
      )
    } else {
      const base = `/proc/${pid}`,
        raw = fs.readFileSync(`${base}/stat`, "utf8"),
        fields = raw.slice(raw.lastIndexOf(") ") + 2).split(" ")
      if (["Z", "X"].includes(fields[0])) throw new Error("God child is no longer live")
      identity = {
        pid,
        parent: Number(fields[1]),
        start: fields[19],
        executable: fs.readlinkSync(`${base}/exe`),
        pidNamespace: fs.readlinkSync(`${base}/ns/pid`),
      }
    }
    if (
      identity.pid !== pid ||
      identity.parent !== process.pid ||
      canonical(identity.executable) !== canonical(process.execPath)
    )
      throw new Error("God child native identity is outside the real daemon")
    const held = births.get(child)
    if (
      held &&
      (identity.start !== held.start ||
        identity.ticks !== held.ticks ||
        identity.parent !== held.parent ||
        identity.pidNamespace !== held.pidNamespace)
    )
      throw new Error("A held God child native birth changed")
    if (!held) births.set(child, Object.freeze(identity))
    return births.get(child)
  }
  const controller = createController(config, {
    cached,
    prime: file => requireDaemon(file),
    god: () => {
      const god = cached(path.join(config.pm2Root, "lib/God.js"))
      if (!god) throw new Error("Real God is not loaded")
      return god
    },
    inspectorUrl: inspector.url,
    canonical,
    observeChild,
    environmentDigest,
    report: event => console.error("[Cached Upgrade Fixture old hot] " + JSON.stringify(event)),
  })
  let tail = Promise.resolve(),
    received = 0
  const reply = frame => {
    if (process.connected)
      try {
        process.send(frame, () => {})
      } catch {}
  }
  process.on("message", value => {
    if (!validateRequest(value, config.nonce) || ++received > 1000) return
    tail = tail
      .then(async () => {
        try {
          const result = await controller(value.command)
          reply({ channel, id: value.id, result })
        } catch (error) {
          reply({ channel, id: value.id, error: error.stack || String(error) })
        }
      })
      .catch(() => {})
  })
}
