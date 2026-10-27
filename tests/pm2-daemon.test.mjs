import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"
import test from "node:test"
import {
  registerPm2Application,
  registerPm2ApplicationWithGod,
  resolveCachedGod,
  preparePm2InspectorCloseWithGod,
} from "../dist/pm2/daemon.js"
import { installPm2Compatibility } from "../dist/pm2/compat.js"

const canonical = file => {
  const resolved = fs.realpathSync.native(file)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}
const immediate = () => new Promise(resolve => setImmediate(resolve))
function project(base, name) {
  const root = path.join(base, name)
  const launcher = path.join(root, "plugins", "独立 插件", "dist", "launcher.js")
  fs.mkdirSync(path.dirname(launcher), { recursive: true })
  fs.writeFileSync(path.join(root, "app.js"), "")
  fs.writeFileSync(launcher, "")
  return { root, launcher }
}
function childFor(project, id, pid, uniqueId = `application-${id}`) {
  const child = new ChildProcess()
  Object.assign(child, {
    pid,
    process: { pid },
    connected: true,
    pm2_env: {
      pm_id: id,
      unique_id: uniqueId,
      status: "online",
      pm_exec_path: path.join(project.root, "app.js"),
      pm_cwd: project.root,
      exec_mode: "fork_mode",
      env: { accountSetting: "retain-me" },
      kill_timeout: 300,
      listen_timeout: 300,
      stop_exit_codes: [9],
    },
  })
  child.sent = []
  child.send = function (message, callback) {
    this.sent.push(message)
    callback?.(null)
    return true
  }
  return child
}
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "guard-pm2-register-"))
  const a = project(base, "项目 A")
  const child = childFor(a, 7, 30007)
  const children = [child]
  const forks = []
  const restarts = []
  const reports = []
  const god = {
    clusters_db: { 7: child },
    processIsDead(pid, environment, cb) {
      cb(null, true)
      return "poll-return"
    },
    handleExit(exiting) {
      exiting.process.pid = 0
      return "handled"
    },
    forkMode(environment, callback) {
      const spawned = childFor(a, environment.pm_id, 40000 + environment.pm_id)
      spawned.pm2_env = environment
      spawned.inheritedTicket = environment.YUNZAI_GUARD_PM2_TICKET
      forks.push(environment)
      children.push(spawned)
      callback.call(god, null, spawned)
      return "fork-return"
    },
    restartProcessId(options, callback) {
      restarts.push(options)
      callback(null)
    },
  }
  // 组件夹具使用模拟观察器；真实系统观察器由冷退出用例中的自有子进程验证。
  const context = {
    daemonPid: 20001,
    report: event => reports.push(event),
    watchBootstrapExit: async (pid, redisPid) => {
      const target = children.find(item => item.pid === pid)
      const done = Promise.withResolvers()
      const onExit = () => done.resolve()
      target.once("exit", onExit)
      return {
        identities: [
          { pid, created: "1", parentPid: 20001 },
          ...(redisPid === null ? [] : [{ pid: redisPid, created: "2", parentPid: pid }]),
        ],
        exited: done.promise,
        close: async () => target.removeListener("exit", onExit),
      }
    },
  }
  const options = {
    pmId: 7,
    pid: child.pid,
    root: a.root,
    launcherPath: a.launcher,
    shutdownTimeout: 1000,
    startupTimeout: 2000,
    nonce: "first-registration-nonce",
    requestRestart: false,
    bootstrapRedisPid: null,
    expectedDaemonPid: context.daemonPid,
    pm2Root: base,
  }
  t.after(() => {
    for (const item of children) item.emit("exit", 0, null)
    assert.match(path.basename(base), /^guard-pm2-register-/)
    assert.equal(canonical(path.dirname(base)), canonical(os.tmpdir()))
    fs.rmSync(base, { recursive: true, force: true })
  })
  const register = update => registerPm2ApplicationWithGod(god, { ...options, ...update }, context)
  const fork = environment => {
    let spawned
    assert.equal(
      god.forkMode(environment, function (error, value) {
        assert.equal(this, god)
        assert.equal(error, null)
        spawned = value
        god.clusters_db[environment.pm_id] = value
      }),
      "fork-return",
    )
    return spawned
  }
  return {
    base,
    a,
    child,
    children,
    forks,
    restarts,
    reports,
    god,
    options,
    context,
    register,
    fork,
  }
}

async function cachedLegacyUpgrade(f) {
  const cache = path.join(f.base, "already-running-daemon-modules")
  fs.mkdirSync(cache)
  fs.writeFileSync(path.join(cache, "package.json"), '{"type":"module"}')
  const compatibilityFile = path.join(cache, "pm2-compat.js")
  const compatibilityUrl = pathToFileURL(compatibilityFile).href
  fs.copyFileSync(new URL("./fixtures/pm2-compat-v0.3.2.js", import.meta.url), compatibilityFile)
  const historical = await import(compatibilityUrl)
  const legacyReports = []
  historical.installPm2Compatibility(f.god, {
    launcherPath: f.a.launcher,
    report: event => legacyReports.push(event),
  })
  const historicalPoll = f.god.processIsDead
  // 模拟原地升级插件，保留 Node 已有模块缓存。
  fs.cpSync(new URL("../dist/", import.meta.url), cache, { recursive: true })
  assert.equal(await import(compatibilityUrl), historical)
  assert.equal(historical.recognizePm2Child, undefined, "The old cached module is truly retained")
  const modern = await import(pathToFileURL(path.join(cache, "pm2-daemon.js")).href)
  return { historical, historicalPoll, modern, legacyReports }
}

test("PM2 cached God resolver reuses its singleton through native Windows casing", async t => {
  const f = fixture(t)
  const file = path.join(f.base, "GodMixedCase.js")
  const unrelated = path.join(f.base, "UnrelatedGod.js")
  fs.writeFileSync(file, 'throw new Error("God code must never be executed by the resolver")')
  fs.writeFileSync(unrelated, 'throw new Error("Unrelated module must not execute")')
  const key = process.platform === "win32" ? file.toLowerCase() : file
  const cache = {
    [key]: { loaded: true, exports: f.god },
    [unrelated]: {
      loaded: true,
      get exports() {
        throw new Error("Unrelated cache exports must not be inspected")
      },
    },
  }
  assert.equal(resolveCachedGod(cache, fs.realpathSync.native(file)), f.god)
  assert.equal(resolveCachedGod(cache, file), f.god)
  assert.equal(cache[key].exports, f.god)
})

test("PM2 cached God resolver rejects ambiguous, absent, incomplete or malformed modules without loading", async t => {
  const f = fixture(t)
  const file = path.join(f.base, "GodMixedCase.js")
  fs.writeFileSync(file, 'throw new Error("Factory must never execute")')
  const alternate = path.dirname(file) + path.sep + "." + path.sep + path.basename(file)
  const cache = {
    [file]: { loaded: true, exports: f.god },
    [alternate]: {
      loaded: true,
      get exports() {
        throw new Error("Ambiguous exports must not be inspected")
      },
    },
  }
  assert.throws(() => resolveCachedGod(cache, file), /PM2 God 须有唯一已加载的规范模块/)
  assert.throws(() => resolveCachedGod({}, file), /PM2 God 须有唯一已加载的规范模块/)
  assert.throws(
    () => resolveCachedGod({ [file]: { loaded: false, exports: f.god } }, file),
    /PM2 God 须有唯一已加载的规范模块/,
  )
  assert.throws(
    () => resolveCachedGod({ [file]: { loaded: true, exports: { clusters_db: [] } } }, file),
    /PM2 缓存的 God 结构不受支持/,
  )
})

function ownedInspector(f) {
  const ownInspectorUrl = "ws://127.0.0.1:42222/guard-owned-test-endpoint"
  let active = ownInspectorUrl
  const calls = []
  const context = {
    ...f.context,
    inspector: {
      url: () => active,
      close: () => {
        calls.push("close")
        active = undefined
      },
    },
  }
  return {
    ownInspectorUrl,
    calls,
    context,
    active: () => active,
    setActive: url => {
      active = url
    },
    prepare: () =>
      preparePm2InspectorCloseWithGod(f.god, { ...f.options, ownInspectorUrl }, context),
    send: update =>
      f.child.emit("message", {
        type: "yunzai-guard-pm2-inspector-close",
        nonce: f.options.nonce,
        url: ownInspectorUrl,
        ...update,
      }),
  }
}

test("PM2 prepares Inspector cleanup without lifecycle mutations and closes only over authenticated IPC", async t => {
  const f = fixture(t)
  const owned = ownedInspector(f)
  const before = structuredClone(f.child.pm2_env)
  const poll = f.god.processIsDead,
    fork = f.god.forkMode,
    exit = f.god.handleExit
  const receipt = owned.prepare()
  assert.equal(receipt.status, "prepared")
  assert.equal(receipt.nonce, f.options.nonce)
  assert.equal(owned.prepare().status, "prepared")
  assert.equal(f.child.listenerCount("message"), 1)
  assert.deepEqual(f.child.pm2_env, before)
  assert.equal(f.god.processIsDead, poll)
  assert.equal(f.god.forkMode, fork)
  assert.equal(f.god.handleExit, exit)
  owned.send({ nonce: "wrong" })
  owned.send({ url: "ws://127.0.0.1:42222/other-session" })
  assert.deepEqual(owned.calls, [])
  const send = f.child.send
  f.child.send = function (message, callback) {
    assert.equal(owned.active(), undefined, "Inspector must be fully closed before acknowledgement")
    return send.call(this, message, callback)
  }
  owned.send()
  owned.send()
  assert.deepEqual(owned.calls, ["close"])
  assert.deepEqual(f.child.sent, [
    {
      type: "yunzai-guard-pm2-inspector-closed",
      nonce: f.options.nonce,
      url: owned.ownInspectorUrl,
      pid: f.child.pid,
      pmId: 7,
      daemonPid: f.context.daemonPid,
    },
  ])
  assert.equal(f.child.listenerCount("message"), 0)
  assert.equal(f.child.listenerCount("exit"), 0)
  assert.ok(f.reports.every(event => !("url" in event) && !("nonce" in event)))
})

test("PM2 registration failure still leaves independent Inspector cleanup available", async t => {
  const f = fixture(t)
  const owned = ownedInspector(f)
  owned.prepare()
  f.child.pm2_env.stop_exit_codes = [{}]
  const poll = f.god.processIsDead
  await assert.rejects(
    () =>
      registerPm2ApplicationWithGod(
        f.god,
        {
          ...f.options,
          ownInspectorUrl: owned.ownInspectorUrl,
        },
        owned.context,
      ),
    /PM2 stop_exit_codes 不受支持/,
  )
  assert.equal(f.god.processIsDead, poll)
  owned.send()
  assert.deepEqual(owned.calls, ["close"])
  assert.equal(f.child.sent.length, 1)
})

test("PM2 cold handoff waits until its prepared Inspector close acknowledgement", async t => {
  const f = fixture(t)
  const owned = ownedInspector(f)
  owned.prepare()
  await registerPm2ApplicationWithGod(
    f.god,
    {
      ...f.options,
      ownInspectorUrl: owned.ownInspectorUrl,
      requestRestart: true,
    },
    owned.context,
  )
  const handoff = () =>
    f.child.emit("message", {
      type: "yunzai-guard-pm2-handoff",
      nonce: f.options.nonce,
    })
  handoff()
  assert.deepEqual(f.restarts, [])
  owned.send()
  assert.equal(f.child.sent[0].type, "yunzai-guard-pm2-inspector-closed")
  handoff()
  assert.deepEqual(f.restarts, [{ id: 7 }])
})

test("PM2 Inspector cleanup refuses stale generations, changed endpoints and invalid ownership", async t => {
  const f = fixture(t)
  const owned = ownedInspector(f)
  owned.prepare()
  const replacement = childFor(f.a, 7, f.child.pid)
  f.god.clusters_db[7] = replacement
  owned.send()
  assert.deepEqual(owned.calls, [])
  f.god.clusters_db[7] = f.child
  owned.setActive("ws://127.0.0.1:42222/replaced-endpoint")
  owned.send()
  assert.deepEqual(owned.calls, [])
  owned.setActive(owned.ownInspectorUrl)
  assert.throws(
    () =>
      preparePm2InspectorCloseWithGod(
        f.god,
        {
          ...f.options,
          pid: f.options.pid + 1,
          ownInspectorUrl: owned.ownInspectorUrl,
        },
        owned.context,
      ),
    /PM2 Inspector 清理子进程身份不符/,
  )
  assert.throws(
    () =>
      preparePm2InspectorCloseWithGod(
        f.god,
        {
          ...f.options,
          ownInspectorUrl: "ws://example.com:9229/foreign",
        },
        owned.context,
      ),
    /临时 Inspector 端点无效/,
  )
  owned.send()
  assert.deepEqual(owned.calls, ["close"])
})

test("PM2 existing Inspector registration needs no close permission and unprepared own endpoints reject", async t => {
  const f = fixture(t)
  const owned = ownedInspector(f)
  const before = structuredClone(f.child.pm2_env)
  await assert.rejects(
    () =>
      registerPm2ApplicationWithGod(
        f.god,
        {
          ...f.options,
          ownInspectorUrl: owned.ownInspectorUrl,
        },
        owned.context,
      ),
    /PM2 临时 Inspector 清理未准备/,
  )
  assert.deepEqual(f.child.pm2_env, before)
  assert.equal(
    (await registerPm2ApplicationWithGod(f.god, f.options, owned.context)).status,
    "registered",
  )
  assert.deepEqual(owned.calls, [])
  assert.equal(f.child.listenerCount("message"), 0)
})

test("PM2 newly activated wildcard endpoints can only prepare cleanup, never register takeover", async t => {
  for (const host of ["0.0.0.0", "[::]"]) {
    const f = fixture(t)
    const ownInspectorUrl = `ws://${host}:42222/owned-wildcard-endpoint`
    let active = ownInspectorUrl
    const context = {
      ...f.context,
      inspector: {
        url: () => active,
        close: () => {
          active = undefined
        },
      },
    }
    const before = structuredClone(f.child.pm2_env)
    assert.equal(
      preparePm2InspectorCloseWithGod(
        f.god,
        {
          ...f.options,
          ownInspectorUrl,
        },
        context,
      ).status,
      "prepared",
    )
    await assert.rejects(
      () =>
        registerPm2ApplicationWithGod(
          f.god,
          {
            ...f.options,
            ownInspectorUrl,
          },
          context,
        ),
      /临时 Inspector 端点无效/,
    )
    assert.deepEqual(f.child.pm2_env, before)
    f.child.emit("message", {
      type: "yunzai-guard-pm2-inspector-close",
      nonce: f.options.nonce,
      url: ownInspectorUrl,
    })
    assert.equal(active, undefined)
    assert.equal(f.child.sent[0].type, "yunzai-guard-pm2-inspector-closed")
  }
})

test("PM2 legacy adapter fixture is the exact pinned 0.3.2 release artifact", () => {
  const metadata = JSON.parse(
    fs.readFileSync(new URL("./fixtures/pm2-compat-v0.3.2.metadata.json", import.meta.url), "utf8"),
  )
  assert.equal(metadata.sourceCommit, "72c33120a832993a8dabc2c2cac1734efc1ec30e")
  assert.equal(metadata.sourcePath, "dist/pm2-compat.js")
  assert.equal(metadata.sourceVersion, "0.3.2-alpha.1")
  assert.equal(metadata.sha256, "37aae5da3e926a1133906f20e876b1ce97868407f1eccdb1a95f8c29e65f8107")
  assert.equal(
    createHash("sha256")
      .update(fs.readFileSync(new URL("./fixtures/pm2-compat-v0.3.2.js", import.meta.url)))
      .digest("hex"),
    metadata.sha256,
  )
})

test("PM2 0.3.2 cached preload upgrades without cache clearing and retains both exit barriers", async t => {
  for (const restoreAppEntry of [false, true]) {
    const f = fixture(t)
    const legacy = await cachedLegacyUpgrade(f)
    const registration = await legacy.modern.registerPm2ApplicationWithGod(
      f.god,
      f.options,
      f.context,
    )
    assert.equal(registration.status, "registered")
    assert.notEqual(f.god.processIsDead, legacy.historicalPoll)
    if (restoreAppEntry) f.child.pm2_env.pm_exec_path = path.join(f.a.root, "app.js")
    let callbacks = 0
    f.god.processIsDead(f.child.pid, f.child.pm2_env, () => callbacks++)
    await immediate()
    assert.equal(callbacks, 0, "Kernel death cannot release old or new adapter callbacks")
    f.child.exitCode = 0
    f.child.emit("exit", 0, null)
    f.god.handleExit(f.child, 0, null)
    assert.equal(callbacks, 0)
    await immediate()
    await immediate()
    assert.equal(callbacks, 1)
    if (!restoreAppEntry)
      assert.ok(legacy.legacyReports.some(event => event.event === "pm2-exit-barrier-complete"))
  }
})

test("PM2 legacy coexistence supports another explicit project while unrelated applications pass through", async t => {
  const f = fixture(t)
  const originalPoll = f.god.processIsDead
  let rawCallback
  f.god.processIsDead = function (pid, environment, callback, sigkill) {
    rawCallback = callback
    return Reflect.apply(originalPoll, this, [pid, environment, callback, sigkill])
  }
  const legacy = await cachedLegacyUpgrade(f)
  await legacy.modern.registerPm2ApplicationWithGod(f.god, f.options, f.context)
  const b = project(f.base, "项目 B")
  const second = childFor(b, 8, 30008)
  f.god.clusters_db[8] = second
  f.children.push(second)
  await legacy.modern.registerPm2ApplicationWithGod(
    f.god,
    {
      ...f.options,
      pmId: 8,
      pid: second.pid,
      root: b.root,
      launcherPath: b.launcher,
    },
    f.context,
  )
  assert.equal(second.pm2_env.pm_exec_path, canonical(b.launcher))
  const c = project(f.base, "未登记应用 C")
  const unrelated = childFor(c, 9, 30009)
  f.god.clusters_db[9] = unrelated
  f.children.push(unrelated)
  const before = structuredClone(unrelated.pm2_env)
  let callbacks = 0
  const callback = () => callbacks++
  assert.equal(f.god.processIsDead(unrelated.pid, unrelated.pm2_env, callback), "poll-return")
  assert.equal(callbacks, 1)
  assert.equal(rawCallback, callback)
  assert.deepEqual(unrelated.pm2_env, before)
  const spawned = f.fork(structuredClone(before))
  assert.deepEqual(spawned.pm2_env, before)
  assert.equal(spawned.inheritedTicket, undefined)
  assert.equal(spawned.listenerCount("message"), 0)
})

test("PM2 hot registration pins only its actual application and conflicting nested metadata", async t => {
  const f = fixture(t)
  const unrelated = childFor(project(f.base, "项目 B"), 8, 30008)
  const untouched = structuredClone(unrelated.pm2_env)
  f.god.clusters_db[8] = unrelated
  Object.assign(f.child.pm2_env.env, {
    pm_exec_path: "stale-app.js",
    pm_id: 999,
    unique_id: "stale",
    wait_ready: false,
    pm_cwd: "stale-root",
    kill_timeout: 5,
    stop_exit_codes: [66],
  })
  const result = await f.register()
  assert.equal(result.requiresHandoff, false)
  assert.equal(result.launcherPath, canonical(f.a.launcher))
  const env = f.child.pm2_env
  assert.equal(env.pm_exec_path, canonical(f.a.launcher))
  assert.equal(env.env.pm_exec_path, env.pm_exec_path)
  assert.equal(env.pm_id, 7)
  assert.equal(Object.hasOwn(env.env, "pm_id"), false)
  assert.equal(env.env.unique_id, "application-7")
  assert.equal(env.env.pm_cwd, canonical(f.a.root))
  assert.equal(env.env.accountSetting, "retain-me")
  assert.equal(env.kill_timeout, 11000)
  assert.equal(env.listen_timeout, 12000)
  assert.equal(env.wait_ready, true)
  assert.equal(env.shutdown_with_message, true)
  assert.deepEqual(env.stop_exit_codes, [9, 78])
  assert.deepEqual(unrelated.pm2_env, untouched)
})

test("PM2 save and fresh-daemon resurrect allocate distinct ids for Guard and its resident peer", async t => {
  const f = fixture(t)
  const resident = childFor(project(f.base, "resident"), 8, 30008)
  f.children.push(resident)
  f.god.clusters_db[8] = resident
  const peerBefore = structuredClone(resident.pm2_env)
  f.child.pm2_env.env.pm_id = 7
  await f.register()
  assert.equal(f.child.pm2_env.pm_id, 7)
  assert.deepEqual(resident.pm2_env, peerBefore)
  const saved = [f.child, resident].map(child => {
    const environment = structuredClone(child.pm2_env)
    // PM2 Startup.dumpProcessList 保存 dump.pm2 前会移除外层 id。
    delete environment.pm_id
    return environment
  })
  let nextId = 0
  const restored = new Map()
  for (const savedEnvironment of saved) {
    // PM2 God.executeApp 在新守护进程分配 id 前会展开 env。
    const environment = Object.assign(structuredClone(savedEnvironment), savedEnvironment.env)
    if (environment.pm_id === undefined) environment.pm_id = nextId++
    restored.set(environment.pm_id, environment)
  }
  assert.equal(nextId, 2)
  assert.deepEqual([...restored.keys()], [0, 1])
  assert.equal(restored.get(0).unique_id, f.child.pm2_env.unique_id)
  assert.equal(restored.get(1).unique_id, resident.pm2_env.unique_id)
  assert.equal(restored.get(0).pm_exec_path, canonical(f.a.launcher))
})

test("PM2 nonremovable nested ids refuse before hooks, registries or peer metadata change", async t => {
  for (const kind of ["nonconfigurable", "accessor"]) {
    const f = fixture(t)
    const resident = childFor(project(f.base, "resident"), 8, 30008)
    f.children.push(resident)
    f.god.clusters_db[8] = resident
    const peerBefore = structuredClone(resident.pm2_env)
    const before = structuredClone(f.child.pm2_env)
    const methods = [f.god.processIsDead, f.god.handleExit, f.god.forkMode]
    const keys = Reflect.ownKeys(f.god)
    let getterCalls = 0
    Object.defineProperty(
      f.child.pm2_env.env,
      "pm_id",
      kind === "accessor"
        ? {
            configurable: true,
            get() {
              getterCalls++
              throw new Error("Nested identity getter must not execute")
            },
          }
        : { value: 7, writable: true, configurable: false },
    )
    const descriptor = Object.getOwnPropertyDescriptor(f.child.pm2_env.env, "pm_id")
    await assert.rejects(f.register(), /PM2 嵌套应用身份须为可删除的自有数据/)
    assert.equal(getterCalls, 0)
    assert.deepEqual(Object.getOwnPropertyDescriptor(f.child.pm2_env.env, "pm_id"), descriptor)
    const unchanged = { ...f.child.pm2_env, env: { ...before.env } }
    assert.deepEqual(unchanged, before)
    assert.deepEqual(resident.pm2_env, peerBefore)
    assert.deepEqual([f.god.processIsDead, f.god.handleExit, f.god.forkMode], methods)
    assert.deepEqual(Reflect.ownKeys(f.god), keys)
  }
})

test("PM2 handoff waits for its matching nonce and current ChildProcess exactly once", async t => {
  const f = fixture(t)
  const result = await f.register({ requestRestart: true })
  assert.equal(result.requiresHandoff, true)
  assert.deepEqual(f.restarts, [])
  const duplicate = await f.register({ requestRestart: true })
  assert.equal(duplicate.requiresHandoff, true)
  assert.equal(f.child.listenerCount("message"), 2)
  f.child.emit("message", { type: "yunzai-guard-pm2-handoff", nonce: "wrong" })
  f.child.emit("message", { type: "application-message", nonce: f.options.nonce })
  assert.deepEqual(f.restarts, [])
  f.child.emit("message", { type: "yunzai-guard-pm2-handoff", nonce: f.options.nonce })
  f.child.emit("message", { type: "yunzai-guard-pm2-handoff", nonce: f.options.nonce })
  assert.deepEqual(f.restarts, [{ id: 7 }])
  assert.equal(f.child.listenerCount("message"), 1, "Commit ledger survives the handoff listener")
})

test("PM2 stale handoff cannot restart a reused id or a changed application", async t => {
  for (const change of ["object", "metadata"]) {
    const f = fixture(t)
    await f.register({ requestRestart: true })
    if (change === "object") f.god.clusters_db[7] = childFor(f.a, 7, f.child.pid)
    else f.child.pm2_env.unique_id = "replacement-application"
    f.child.emit("message", { type: "yunzai-guard-pm2-handoff", nonce: f.options.nonce })
    assert.deepEqual(f.restarts, [])
    assert.equal(f.child.listenerCount("message"), 0)
  }
})

test("PM2 original ecosystem app.js is rewritten on each registered fork with a fresh private ticket", async t => {
  const f = fixture(t)
  await f.register()
  const environment = structuredClone(f.child.pm2_env)
  environment.pm_exec_path = path.join(f.a.root, "app.js")
  environment.env.pm_exec_path = "old-nested-entry"
  environment.env.pm_id = 7
  environment.wait_ready = false
  environment.kill_timeout = 1
  const spawned = f.fork(environment)
  assert.equal(environment.pm_exec_path, canonical(f.a.launcher))
  assert.equal(environment.env.pm_exec_path, canonical(f.a.launcher))
  assert.equal(environment.pm_id, 7)
  assert.equal(Object.hasOwn(environment.env, "pm_id"), false)
  assert.equal(environment.kill_timeout, 11000)
  assert.equal(environment.wait_ready, true)
  assert.equal(environment.YUNZAI_GUARD_PM2_TICKET, undefined)
  assert.equal(environment.env.YUNZAI_GUARD_PM2_TICKET, undefined)
  assert.match(spawned.inheritedTicket, /^[0-9a-f]{64}$/)
  const ticket = spawned.inheritedTicket
  spawned.emit("message", { type: "yunzai-guard-pm2-check", nonce: "wrong" })
  spawned.emit("message", { type: "application-message", nonce: ticket })
  assert.deepEqual(spawned.sent, [])
  spawned.emit("message", { type: "yunzai-guard-pm2-check", nonce: ticket })
  assert.deepEqual(spawned.sent, [
    {
      type: "yunzai-guard-pm2-registered",
      nonce: ticket,
      pid: spawned.pid,
      pmId: 7,
      daemonPid: f.context.daemonPid,
      launcherPath: canonical(f.a.launcher),
    },
  ])
  const next = structuredClone(environment)
  const replacement = f.fork(next)
  assert.notEqual(replacement.inheritedTicket, ticket)
  spawned.emit("message", { type: "yunzai-guard-pm2-check", nonce: ticket })
  assert.equal(spawned.sent.length, 1, "An old ChildProcess cannot authenticate the replacement")
  replacement.emit("exit", 0, null)
  assert.equal(replacement.listenerCount("message"), 0)
})

test("PM2 registration fixes the initial cold process exit barrier before any handoff", async t => {
  const f = fixture(t)
  await f.register({ requestRestart: true })
  let stopped = 0
  f.god.processIsDead(f.child.pid, f.child.pm2_env, () => stopped++)
  await immediate()
  assert.equal(stopped, 0)
  f.child.emit("message", { type: "yunzai-guard-pm2-exit-commit", nonce: f.options.nonce })
  f.child.exitCode = 0
  f.child.emit("exit", 0, null)
  f.god.handleExit(f.child, 0, null)
  await immediate()
  await immediate()
  assert.equal(stopped, 1)
})

test("PM2 metadata update back to app.js before stop cannot remove initial or later generation barriers", async t => {
  const f = fixture(t)
  await f.register()
  const spawned = f.fork(structuredClone(f.child.pm2_env))
  for (const child of [f.child, spawned]) {
    f.god.clusters_db[7] = child
    child.pm2_env.pm_exec_path = path.join(f.a.root, "app.js")
    let callbacks = 0
    f.god.processIsDead(child.pid, child.pm2_env, () => callbacks++)
    await immediate()
    assert.equal(callbacks, 0)
    child.exitCode = 0
    child.emit("exit", 0, null)
    f.god.handleExit(child, 0, null)
    await immediate()
    assert.equal(callbacks, 1)
  }
})

test("PM2 unregistered forks, new unique ids and different scripts retain their original environment", async t => {
  const f = fixture(t)
  await f.register()
  const otherScript = path.join(f.a.root, "unrelated.js")
  fs.writeFileSync(otherScript, "")
  for (const update of [
    { pm_id: 88 },
    { unique_id: "new-application" },
    { pm_exec_path: otherScript },
    { exec_mode: "cluster_mode" },
  ]) {
    const environment = { ...structuredClone(f.child.pm2_env), ...update }
    const before = structuredClone(environment)
    const spawned = f.fork(environment)
    assert.deepEqual(environment, before)
    assert.equal(spawned.listenerCount("message"), 0)
  }
})

test("PM2 multiple projects and module copies share one hook with separate exact registrations", async t => {
  const f = fixture(t)
  installPm2Compatibility(f.god, { launcherPath: f.a.launcher })
  const compatibility = f.god.processIsDead
  await f.register()
  const wrapper = f.god.forkMode
  const b = project(f.base, "项目 B")
  const other = childFor(b, 8, 30008)
  f.god.clusters_db[8] = other
  f.children.push(other)
  const copy = await import("../dist/pm2-daemon.js?separate-installed-copy")
  await copy.registerPm2ApplicationWithGod(
    f.god,
    {
      ...f.options,
      pmId: 8,
      pid: other.pid,
      root: b.root,
      launcherPath: b.launcher,
    },
    f.context,
  )
  assert.equal(f.god.forkMode, wrapper)
  assert.equal(f.god.processIsDead, compatibility)
  for (const original of [f.child, other]) {
    const environment = structuredClone(original.pm2_env)
    environment.pm_exec_path = path.join(environment.pm_cwd, "app.js")
    f.fork(environment)
    assert.equal(
      environment.pm_exec_path,
      canonical(original === f.child ? f.a.launcher : b.launcher),
    )
  }
})

test("PM2 duplicate active project is rejected but an exited prior application does not block", async t => {
  const f = fixture(t)
  const duplicate = childFor(f.a, 8, 30008)
  f.god.clusters_db[8] = duplicate
  const original = f.god.forkMode
  const before = structuredClone(f.child.pm2_env)
  await assert.rejects(() => f.register(), /另一个运行中的 PM2 应用正在使用此项目/)
  assert.equal(f.god.forkMode, original)
  assert.deepEqual(f.child.pm2_env, before)
  duplicate.exitCode = 0
  assert.equal((await f.register()).status, "registered")
})

test("PM2 invalid identity and unsupported writable state fail before any registration mutation", async t => {
  const changes = [
    f => ({ pid: f.child.pid + 1 }),
    f => ({ expectedDaemonPid: f.context.daemonPid + 1 }),
    f => {
      f.child.pm2_env.exec_mode = "cluster_mode"
      return {}
    },
    f => {
      f.child.pm2_env.status = "stopping"
      return {}
    },
    f => {
      f.child.pm2_env.env = []
      return {}
    },
    f => {
      Object.freeze(f.child.pm2_env.env)
      return {}
    },
    f => {
      f.child.pm2_env.stop_exit_codes = [{}]
      return {}
    },
    f => {
      fs.writeFileSync(path.join(f.a.root, "other.js"), "")
      f.child.pm2_env.pm_exec_path = path.join(f.a.root, "other.js")
      return {}
    },
  ]
  for (const change of changes) {
    const f = fixture(t)
    const update = change(f)
    const before = structuredClone(f.child.pm2_env)
    const original = { fork: f.god.forkMode, poll: f.god.processIsDead, exit: f.god.handleExit }
    await assert.rejects(() => f.register(update))
    assert.deepEqual(f.child.pm2_env, before)
    assert.equal(f.god.forkMode, original.fork)
    assert.equal(f.god.processIsDead, original.poll)
    assert.equal(f.god.handleExit, original.exit)
    assert.equal(Reflect.has(f.god, Symbol.for("yunzai-guard.pm2-daemon.v1")), false)
  }
})

test("PM2 unknown shared registry protocol fails before target metadata or hooks change", async t => {
  const f = fixture(t)
  Object.defineProperty(f.god, Symbol.for("yunzai-guard.pm2-daemon.v1"), {
    value: { protocol: 99 },
  })
  const before = structuredClone(f.child.pm2_env)
  const original = f.god.processIsDead
  await assert.rejects(() => f.register(), /PM2 守护进程登记表不受支持/)
  assert.equal(f.god.processIsDead, original)
  assert.deepEqual(f.child.pm2_env, before)
})

test("PM2 public runtime entry refuses a normal application instead of attaching by a supplied path", async t => {
  const f = fixture(t)
  await assert.rejects(() =>
    registerPm2Application({ ...f.options, expectedDaemonPid: process.pid }),
  )
})

function controlledObserver(f, redisPid = null) {
  const done = Promise.withResolvers()
  void done.promise.catch(() => {})
  let closed = 0
  f.context.watchBootstrapExit = async () => ({
    identities: [
      { pid: f.child.pid, created: "10", parentPid: f.context.daemonPid },
      ...(redisPid === null ? [] : [{ pid: redisPid, created: "11", parentPid: f.child.pid }]),
    ],
    exited: done.promise,
    close: async () => {
      closed++
    },
  })
  return { ...done, closed: () => closed }
}

test("cold PM2 root exit and polling cannot bypass a live owned resource", async t => {
  const f = fixture(t)
  const observer = controlledObserver(f, 30101)
  const receipt = await f.register({ requestRestart: true, bootstrapRedisPid: 30101 })
  assert.equal(receipt.bootstrapExitBarrier, 1)
  let callbacks = 0
  f.god.processIsDead(f.child.pid, f.child.pm2_env, () => callbacks++)
  f.child.emit("message", { type: "yunzai-guard-pm2-exit-commit", nonce: "foreign" })
  f.child.emit("message", { type: "yunzai-guard-pm2-exit-commit", nonce: f.options.nonce })
  f.child.emit("message", { type: "yunzai-guard-pm2-exit-commit", nonce: f.options.nonce })
  f.child.exitCode = 0
  f.child.emit("exit", 0, null)
  f.god.handleExit(f.child, 0, null)
  await immediate()
  assert.equal(callbacks, 0)
  assert.equal(
    f.child.process.pid,
    f.child.pid,
    "Original handleExit cannot schedule an automatic restart",
  )
  let blocked
  assert.equal(
    f.god.forkMode(structuredClone(f.child.pm2_env), error => {
      blocked = error
    }),
    false,
  )
  assert.match(blocked.message, /PM2 原进程资源退出未确认/)
  let differentIdBlocked
  f.god.forkMode({ ...structuredClone(f.child.pm2_env), pm_id: 77, unique_id: "new-id" }, error => {
    differentIdBlocked = error
  })
  assert.match(differentIdBlocked.message, /PM2 原进程资源退出未确认/)
  const sameCwdPeer = path.join(f.a.root, "unrelated-peer.js")
  fs.writeFileSync(sameCwdPeer, "")
  const peerEnvironment = {
    ...structuredClone(f.child.pm2_env),
    pm_id: 78,
    unique_id: "peer",
    pm_exec_path: sameCwdPeer,
  }
  const sameCwdBefore = structuredClone(peerEnvironment)
  f.fork(peerEnvironment)
  assert.deepEqual(peerEnvironment, sameCwdBefore)
  assert.equal(f.forks.length, 1)
  observer.resolve()
  await immediate()
  await immediate()
  assert.equal(callbacks, 1)
  assert.equal(f.child.process.pid, 0)
  assert.equal(observer.closed(), 1)
})

test("missing cold commit blocks automatic exit and changed-unique-id fork while peer is untouched", async t => {
  const f = fixture(t)
  const observer = controlledObserver(f)
  await f.register({ requestRestart: true })
  let callbacks = 0
  f.god.processIsDead(f.child.pid, f.child.pm2_env, () => callbacks++)
  f.child.exitCode = 0
  f.child.emit("exit", 0, null)
  f.god.handleExit(f.child, 0, null)
  observer.resolve()
  await immediate()
  assert.equal(callbacks, 0)
  assert.equal(f.child.process.pid, f.child.pid)
  let blocked
  f.god.forkMode({ ...structuredClone(f.child.pm2_env), unique_id: "changed" }, error => {
    blocked = error
  })
  assert.match(blocked.message, /PM2 原进程资源退出未确认/)
  const other = project(f.base, "Independent peer")
  const peer = childFor(other, 8, 30008)
  f.god.clusters_db[8] = peer
  f.children.push(peer)
  const before = structuredClone(peer.pm2_env)
  const spawned = f.fork(structuredClone(peer.pm2_env))
  assert.deepEqual(spawned.pm2_env, before)
  assert.deepEqual(peer.pm2_env, before)
  assert.equal(f.forks.length, 1)
})

test("cold observer failure or nonzero root exit never releases PM2 callbacks", async t => {
  for (const reason of ["observer", "root-code"]) {
    const f = fixture(t)
    const observer = controlledObserver(f)
    await f.register({ requestRestart: true })
    let callbacks = 0
    f.god.processIsDead(f.child.pid, f.child.pm2_env, () => callbacks++)
    f.child.emit("message", { type: "yunzai-guard-pm2-exit-commit", nonce: f.options.nonce })
    f.child.exitCode = reason === "root-code" ? 1 : 0
    f.child.emit("exit", f.child.exitCode, null)
    f.god.handleExit(f.child, f.child.exitCode, null)
    if (reason === "observer") observer.reject(new Error("actual observer unavailable"))
    else observer.resolve()
    await immediate()
    assert.equal(callbacks, 0)
    assert.equal(f.child.process.pid, f.child.pid)
    assert.equal(observer.closed(), 1)
    await assert.rejects(() => f.register({ requestRestart: true }), /身份|未确认|应用|失败/)
  }
})

test("cold observer arming revalidates the exact application after awaiting OS readiness", async t => {
  const f = fixture(t)
  const ready = Promise.withResolvers()
  const exit = Promise.withResolvers()
  void exit.promise.catch(() => {})
  let closed = 0
  f.context.watchBootstrapExit = () => ready.promise
  const before = structuredClone(f.child.pm2_env)
  const original = { poll: f.god.processIsDead, fork: f.god.forkMode, exit: f.god.handleExit }
  const pending = f.register({ requestRestart: true })
  f.god.clusters_db[7] = childFor(f.a, 7, f.child.pid)
  ready.resolve({
    identities: [{ pid: f.child.pid, created: "10", parentPid: f.context.daemonPid }],
    exited: exit.promise,
    close: async () => {
      closed++
    },
  })
  await assert.rejects(pending, /布置退出观察器期间 PM2 应用已变化/)
  assert.equal(closed, 1)
  assert.deepEqual(f.child.pm2_env, before)
  assert.equal(f.god.processIsDead, original.poll)
  assert.equal(f.god.forkMode, original.fork)
  assert.equal(f.god.handleExit, original.exit)
})

test("cold observer arming revalidates writable metadata before installing hooks", async t => {
  const f = fixture(t)
  const ready = Promise.withResolvers()
  let closed = 0
  f.context.watchBootstrapExit = () => ready.promise
  const original = { poll: f.god.processIsDead, fork: f.god.forkMode, exit: f.god.handleExit }
  const pending = f.register({ requestRestart: true })
  Object.freeze(f.child.pm2_env.env)
  ready.resolve({
    identities: [{ pid: f.child.pid, created: "10", parentPid: f.context.daemonPid }],
    exited: new Promise(() => {}),
    close: async () => {
      closed++
    },
  })
  await assert.rejects(pending, /描述符|不可扩展/)
  assert.equal(closed, 1)
  assert.equal(f.god.processIsDead, original.poll)
  assert.equal(f.god.forkMode, original.fork)
  assert.equal(f.god.handleExit, original.exit)
})

test("cold observer rejects replacement of the whole pm2_env object during OS arming", async t => {
  const f = fixture(t)
  const ready = Promise.withResolvers()
  let closed = 0
  f.context.watchBootstrapExit = () => ready.promise
  const originalEnvironment = f.child.pm2_env
  const original = { poll: f.god.processIsDead, fork: f.god.forkMode, exit: f.god.handleExit }
  const pending = f.register({ requestRestart: true })
  f.child.pm2_env = {
    ...structuredClone(originalEnvironment),
    pm_exec_path: f.a.launcher,
    shutdown_with_message: false,
    kill_timeout: 1,
  }
  const replacementBefore = structuredClone(f.child.pm2_env)
  ready.resolve({
    identities: [{ pid: f.child.pid, created: "10", parentPid: f.context.daemonPid }],
    exited: new Promise(() => {}),
    close: async () => {
      closed++
    },
  })
  await assert.rejects(pending, /布置退出观察器期间 PM2 应用已变化/)
  assert.equal(closed, 1)
  assert.deepEqual(f.child.pm2_env, replacementBefore)
  assert.equal(f.god.processIsDead, original.poll)
  assert.equal(f.god.forkMode, original.fork)
  assert.equal(f.god.handleExit, original.exit)
})

test("cold metadata object replacement after registration cannot request a handoff or renew its receipt", async t => {
  const f = fixture(t)
  const observer = controlledObserver(f)
  await f.register({ requestRestart: true })
  f.child.pm2_env = {
    ...structuredClone(f.child.pm2_env),
    shutdown_with_message: false,
    kill_timeout: 1,
  }
  await assert.rejects(() => f.register({ requestRestart: true }), /身份不符|未确认/)
  f.child.emit("message", { type: "yunzai-guard-pm2-handoff", nonce: f.options.nonce })
  await immediate()
  assert.deepEqual(f.restarts, [])
  assert.equal(observer.closed(), 1)
})

test("cold Redis declaration and nonce cannot be omitted, forged or replaced by duplicate registration", async t => {
  const f = fixture(t)
  const before = structuredClone(f.child.pm2_env)
  for (const bootstrapRedisPid of [undefined, 0, -1, 1.5, f.child.pid])
    await assert.rejects(
      () => f.register({ requestRestart: true, bootstrapRedisPid }),
      /Redis 身份/,
    )
  assert.deepEqual(f.child.pm2_env, before)
  await f.register({ requestRestart: true })
  await assert.rejects(
    () => f.register({ requestRestart: true, nonce: "different-registration-nonce" }),
    /PM2 交接已有不同的随机数/,
  )
  await assert.rejects(
    () => f.register({ requestRestart: true, bootstrapRedisPid: 31234 }),
    /PM2 冷启动原进程退出未确认或身份不符/,
  )
  assert.deepEqual(f.restarts, [])
})

test("a known older adapter gets a real sidecar without a fabricated legacy resource capability", async t => {
  const f = fixture(t)
  const original = { fork: f.god.forkMode, poll: f.god.processIsDead, exit: f.god.handleExit }
  const before = structuredClone(f.child.pm2_env)
  Object.defineProperty(f.god, Symbol.for("yunzai-guard.pm2-compat.v1"), {
    value: {
      protocol: 1,
      launchers: new Set([canonical(f.a.launcher)]),
      processIsDead: original.poll,
      handleExit: original.exit,
      recognize() {},
    },
  })
  const legacy = f.god[Symbol.for("yunzai-guard.pm2-compat.v1")]
  const result = await f.register({ requestRestart: true })
  assert.equal(result.bootstrapExitBarrier, 1)
  assert.equal(legacy.bootstrapExitProtocol, undefined)
  assert.equal(legacy.bindBootstrapExit, undefined)
  assert.equal(legacy.processIsDead, f.god.processIsDead)
  assert.equal(legacy.handleExit, f.god.handleExit)
  assert.notEqual(f.god.processIsDead, original.poll)
  assert.notEqual(f.god.handleExit, original.exit)
  assert.notEqual(f.god.forkMode, original.fork)
  let stopped = 0
  f.god.processIsDead(f.child.pid, f.child.pm2_env, () => stopped++)
  f.child.exitCode = 0
  f.child.emit("exit", 0, null)
  f.god.handleExit(f.child, 0, null)
  await immediate()
  assert.equal(stopped, 0, "The new sidecar must really require the private commit")
  assert.notDeepEqual(f.child.pm2_env, before)
})

async function cachedSharedV1(f, installPeer = true) {
  const cache = path.join(f.base, "shared-v1-cached-agent")
  fs.cpSync(new URL("./fixtures/pm2-r26/", import.meta.url), cache, { recursive: true })
  fs.writeFileSync(path.join(cache, "package.json"), '{"type":"module"}')
  const url = pathToFileURL(path.join(cache, "pm2-daemon.js")).href
  const historical = await import(url)
  if (installPeer) await historical.registerPm2ApplicationWithGod(f.god, f.options, f.context)
  const beforeLoad = [f.god.processIsDead, f.god.handleExit, f.god.forkMode]
  const beforeListeners = f.child.listenerCount("message")
  fs.cpSync(new URL("../dist/", import.meta.url), cache, { recursive: true })
  assert.equal(await import(url), historical, "The exact old agent URL remains cached")
  assert.equal(historical.pm2AgentCapabilities, undefined)
  const modern = await import(pathToFileURL(path.join(cache, "pm2/agent-v2.js")).href)
  assert.deepEqual(modern.pm2AgentCapabilities, {
    agentProtocol: 2,
    bootstrapExitBarrier: 1,
    cachedRegistryUpgrade: 1,
  })
  assert.ok(Object.isFrozen(modern.pm2AgentCapabilities))
  assert.deepEqual(
    [f.god.processIsDead, f.god.handleExit, f.god.forkMode],
    beforeLoad,
    "Loading versioned modules must not install lifecycle hooks",
  )
  assert.equal(f.child.listenerCount("message"), beforeListeners)
  return { historical, modern }
}

test("a verified legacy target removes only its own saved nested id without replacing its registry", async t => {
  for (const removable of [true, false]) {
    const f = fixture(t)
    const { modern } = await cachedSharedV1(f)
    const resident = childFor(project(f.base, "resident"), 8, 30008)
    resident.pm2_env.env.pm_id = 8
    f.children.push(resident)
    f.god.clusters_db[8] = resident
    const peerBefore = structuredClone(resident.pm2_env)
    Object.defineProperty(f.child.pm2_env.env, "pm_id", {
      value: 7,
      enumerable: true,
      writable: false,
      configurable: removable,
    })
    const before = structuredClone(f.child.pm2_env)
    const registry = f.god[Symbol.for("yunzai-guard.pm2-daemon.v1")]
    const entry = registry.applications.get(7)
    const methods = [f.god.processIsDead, f.god.handleExit, f.god.forkMode]
    const keys = Reflect.ownKeys(f.god)
    if (removable) {
      assert.equal(
        (await modern.registerPm2ApplicationWithGod(f.god, f.options, f.context)).requiresHandoff,
        false,
      )
      delete before.env.pm_id
    } else {
      await assert.rejects(
        modern.registerPm2ApplicationWithGod(f.god, f.options, f.context),
        /PM2 嵌套应用身份须为可删除的自有数据/,
      )
    }
    assert.deepEqual(f.child.pm2_env, before)
    assert.deepEqual(resident.pm2_env, peerBefore)
    assert.equal(registry.applications.get(7), entry)
    assert.deepEqual([f.god.processIsDead, f.god.handleExit, f.god.forkMode], methods)
    assert.deepEqual(Reflect.ownKeys(f.god), keys)
  }
})

function secondCold(f) {
  const b = project(f.base, "新冷目标 B")
  const child = childFor(b, 8, 30008)
  f.god.clusters_db[8] = child
  f.children.push(child)
  return {
    b,
    child,
    options: {
      ...f.options,
      pmId: 8,
      pid: child.pid,
      root: b.root,
      launcherPath: b.launcher,
      requestRestart: true,
      bootstrapRedisPid: null,
      nonce: "new-cold-registration-nonce",
    },
  }
}

test("R26 historical registration import closure is byte-pinned independently of current implementations", () => {
  const metadata = JSON.parse(
    fs.readFileSync(new URL("./fixtures/pm2-r26/metadata.json", import.meta.url)),
  )
  assert.equal(metadata.files.length, 3)
  for (const file of metadata.files) {
    const bytes = fs.readFileSync(new URL("./fixtures/pm2-r26/" + file.path, import.meta.url))
    assert.equal(bytes.length, file.bytes)
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256)
  }
  assert.equal(
    metadata.files.find(row => row.path === "pm2-daemon.js").sha256,
    "6e64110be8c64fb3950284b3ee84cd0c96329dabbf03dc29e2b84a61653e8d16",
  )
})

test("cached R26 agent upgrades a new cold target while old peer pending and later registrations retain their chain", async t => {
  const f = fixture(t)
  const receiver = { originalPolling: true }
  f.god.processIsDead = function (pid, environment, callback) {
    callback.call(receiver, null, true)
    return "poll-return"
  }
  const legacy = await cachedSharedV1(f)
  const compatibility = f.god[Symbol.for("yunzai-guard.pm2-compat.v1")]
  const registry = f.god[Symbol.for("yunzai-guard.pm2-daemon.v1")]
  const oldEntry = registry.applications.get(7)
  const oldLaunchers = [...compatibility.launchers]
  const peerEnvironment = structuredClone(f.child.pm2_env)
  let peerStops = 0
  f.god.processIsDead(f.child.pid, f.child.pm2_env, function (...args) {
    assert.equal(this, receiver)
    assert.deepEqual(args, [null, true])
    peerStops++
  })
  const next = secondCold(f)
  const resources = Promise.withResolvers()
  let observerClosed = 0
  const context = {
    ...f.context,
    watchBootstrapExit: async pid => ({
      identities: [{ pid, created: "1", parentPid: f.context.daemonPid }],
      exited: resources.promise,
      close: async () => {
        observerClosed++
      },
    }),
  }
  const result = await legacy.modern.registerPm2ApplicationWithGod(f.god, next.options, context)
  assert.equal(result.bootstrapExitBarrier, 1)
  assert.equal(compatibility.bootstrapExitProtocol, undefined)
  assert.equal(compatibility.bindBootstrapExit, undefined)
  assert.equal(compatibility.processIsDead, f.god.processIsDead)
  assert.equal(compatibility.handleExit, f.god.handleExit)
  assert.equal(registry.forkMode, f.god.forkMode)
  assert.deepEqual([...compatibility.launchers], oldLaunchers)
  assert.equal(registry.applications.get(7), oldEntry)
  assert.equal(
    registry.applications.has(8),
    false,
    "The legacy fork owner never owns the new target",
  )
  assert.deepEqual(f.child.pm2_env, peerEnvironment)
  assert.equal(peerStops, 0)
  await legacy.historical.registerPm2ApplicationWithGod(f.god, f.options, f.context)
  assert.equal(peerStops, 0, "A repeated old registration cannot discard a pending old callback")
  f.child.exitCode = 0
  f.child.emit("exit", 0, null)
  f.god.handleExit(f.child, 0, null)
  await immediate()
  await immediate()
  assert.equal(peerStops, 1)
  for (const action of ["restart", "reload"]) {
    const peer = f.fork(structuredClone(peerEnvironment))
    assert.match(peer.inheritedTicket, /^[a-f0-9]{64}$/)
    assert.equal(peer.listenerCount("message"), 1, `${action} has exactly one old ticket owner`)
    peer.emit("message", { type: "yunzai-guard-pm2-check", nonce: peer.inheritedTicket })
    assert.equal(
      peer.sent.filter(message => message.type === "yunzai-guard-pm2-registered").length,
      1,
    )
    await legacy.historical.registerPm2ApplicationWithGod(
      f.god,
      { ...f.options, pid: peer.pid },
      f.context,
    )
    const hot = await legacy.modern.registerPm2ApplicationWithGod(
      f.god,
      { ...f.options, pid: peer.pid },
      f.context,
    )
    assert.equal(hot.requiresHandoff, false)
    peer.exitCode = 0
    peer.emit("exit", 0, null)
    f.god.handleExit(peer, 0, null)
  }
  let newStops = 0
  f.god.processIsDead(next.child.pid, next.child.pm2_env, () => newStops++)
  next.child.emit("message", { type: "yunzai-guard-pm2-exit-commit", nonce: next.options.nonce })
  next.child.exitCode = 0
  next.child.emit("exit", 0, null)
  f.god.handleExit(next.child, 0, null)
  await immediate()
  assert.equal(newStops, 0)
  let blocked
  f.god.forkMode(
    { ...next.child.pm2_env, pm_id: 99, pm_exec_path: path.join(next.b.root, "app.js") },
    error => {
      blocked = error
    },
  )
  assert.match(blocked.message, /PM2 原进程资源退出未确认/)
  resources.resolve()
  await immediate()
  await immediate()
  assert.equal(observerClosed, 1)
  assert.equal(newStops, 1)
  const current = f.fork(structuredClone(next.child.pm2_env))
  assert.equal(current.listenerCount("message"), 1)
  current.emit("message", { type: "yunzai-guard-pm2-check", nonce: current.inheritedTicket })
  assert.equal(
    current.sent.filter(message => message.type === "yunzai-guard-pm2-registered").length,
    1,
  )
  assert.equal(registry.applications.has(8), false)
})

test("a legacy target cannot be cold-migrated based on an absent handoff field", async t => {
  const f = fixture(t)
  const { modern } = await cachedSharedV1(f)
  f.child.pm2_env.pm_exec_path = path.join(f.a.root, "app.js")
  const before = structuredClone(f.child.pm2_env)
  const methods = [f.god.processIsDead, f.god.handleExit, f.god.forkMode]
  let watched = 0
  await assert.rejects(
    () =>
      modern.registerPm2ApplicationWithGod(
        f.god,
        { ...f.options, requestRestart: true },
        {
          ...f.context,
          watchBootstrapExit: async () => {
            watched++
            throw new Error("must not arm")
          },
        },
      ),
    /PM2 旧版目标归属未定或无法安全迁移/,
  )
  assert.equal(watched, 0)
  assert.deepEqual(f.child.pm2_env, before)
  assert.deepEqual([f.god.processIsDead, f.god.handleExit, f.god.forkMode], methods)
})

test("legacy read-only pointers and accessors refuse before any lineage or selected metadata write", async t => {
  for (const kind of ["compat-pointer", "fork-pointer", "compat-accessor"]) {
    const f = fixture(t)
    const { modern } = await cachedSharedV1(f, kind !== "compat-accessor")
    const next = secondCold(f)
    let accessorReads = 0
    if (kind === "compat-pointer")
      Object.defineProperty(f.god[Symbol.for("yunzai-guard.pm2-compat.v1")], "handleExit", {
        writable: false,
      })
    if (kind === "fork-pointer")
      Object.defineProperty(f.god[Symbol.for("yunzai-guard.pm2-daemon.v1")], "forkMode", {
        writable: false,
      })
    if (kind === "compat-accessor")
      Object.defineProperty(f.god, Symbol.for("yunzai-guard.pm2-compat.v1"), {
        get() {
          accessorReads++
          throw new Error("must not execute")
        },
      })
    const methods = [f.god.processIsDead, f.god.handleExit, f.god.forkMode]
    const before = structuredClone(next.child.pm2_env)
    await assert.rejects(
      () => modern.registerPm2ApplicationWithGod(f.god, next.options, f.context),
      /方法链|登记链|访问器/,
    )
    assert.equal(accessorReads, 0)
    assert.deepEqual(next.child.pm2_env, before)
    assert.deepEqual([f.god.processIsDead, f.god.handleExit, f.god.forkMode], methods)
  }
})

test("legacy Map containers and coherently replaced method chains are revalidated after OS arming", async t => {
  for (const kind of ["map", "methods"]) {
    const f = fixture(t)
    const { modern } = await cachedSharedV1(f)
    const next = secondCold(f)
    const before = structuredClone(next.child.pm2_env)
    const registry = f.god[Symbol.for("yunzai-guard.pm2-daemon.v1")]
    let closed = 0
    await assert.rejects(
      () =>
        modern.registerPm2ApplicationWithGod(f.god, next.options, {
          ...f.context,
          watchBootstrapExit: async pid => {
            if (kind === "map") registry.applications = new Map(registry.applications)
            else {
              f.god.forkMode = function () {}
              registry.forkMode = f.god.forkMode
            }
            return {
              identities: [{ pid, created: "1", parentPid: f.context.daemonPid }],
              exited: new Promise(() => {}),
              close: async () => {
                closed++
              },
            }
          },
        }),
      /链已变化|布置退出观察器期间/,
    )
    assert.equal(closed, 1)
    assert.deepEqual(next.child.pm2_env, before)
    assert.equal(f.god[Symbol.for("yunzai-guard.pm2-daemon.resource.v1")], undefined)
  }
})

test("pinned 0.3.2 adapter supports a true cold external and owned-resource gate without cache clearing", async t => {
  for (const redisPid of [null, 31234]) {
    const f = fixture(t)
    const legacy = await cachedLegacyUpgrade(f)
    const resources = Promise.withResolvers()
    let closed = 0
    const context = {
      ...f.context,
      watchBootstrapExit: async pid => ({
        identities: [
          { pid, created: "1", parentPid: f.context.daemonPid },
          ...(redisPid === null ? [] : [{ pid: redisPid, created: "2", parentPid: pid }]),
        ],
        exited: resources.promise,
        close: async () => {
          closed++
        },
      }),
    }
    const result = await legacy.modern.registerPm2ApplicationWithGod(
      f.god,
      { ...f.options, requestRestart: true, bootstrapRedisPid: redisPid },
      context,
    )
    assert.equal(result.bootstrapExitBarrier, 1)
    let stopped = 0
    f.god.processIsDead(f.child.pid, f.child.pm2_env, () => stopped++)
    f.child.emit("message", { type: "yunzai-guard-pm2-exit-commit", nonce: f.options.nonce })
    f.child.exitCode = 0
    f.child.emit("exit", 0, null)
    f.god.handleExit(f.child, 0, null)
    await immediate()
    assert.equal(stopped, 0)
    assert.equal(
      legacy.legacyReports.filter(event => event.event === "pm2-exit-barrier-complete").length,
      0,
    )
    resources.resolve()
    for (let index = 0; index < 4; index++) await immediate()
    assert.equal(stopped, 1)
    assert.equal(closed, 1)
    assert.ok(legacy.legacyReports.some(event => event.event === "pm2-exit-barrier-complete"))
  }
})

test("unknown legacy Map and Set instance hooks are rejected without executing their accessors", async t => {
  for (const kind of ["map-iterator", "map-get", "set-iterator", "set-add", "map-proxy"]) {
    const f = fixture(t)
    const { modern } = await cachedSharedV1(f)
    const next = secondCold(f)
    const registry = f.god[Symbol.for("yunzai-guard.pm2-daemon.v1")]
    const compatibility = f.god[Symbol.for("yunzai-guard.pm2-compat.v1")]
    let reads = 0
    const bad = {
      get() {
        reads++
        throw new Error("unknown collection hook must not run")
      },
    }
    if (kind === "map-iterator") Object.defineProperty(registry.applications, Symbol.iterator, bad)
    if (kind === "map-get") Object.defineProperty(registry.applications, "get", bad)
    if (kind === "set-iterator")
      Object.defineProperty(compatibility.launchers, Symbol.iterator, bad)
    if (kind === "set-add") Object.defineProperty(compatibility.launchers, "add", bad)
    if (kind === "map-proxy")
      registry.applications = new Proxy(registry.applications, {
        get() {
          reads++
          throw new Error("proxy must not run")
        },
        ownKeys() {
          reads++
          throw new Error("proxy keys must not run")
        },
      })
    const methods = [f.god.processIsDead, f.god.handleExit, f.god.forkMode]
    const before = structuredClone(next.child.pm2_env)
    await assert.rejects(
      () => modern.registerPm2ApplicationWithGod(f.god, next.options, f.context),
      /登记表|登记记录/,
    )
    assert.equal(reads, 0)
    assert.deepEqual(next.child.pm2_env, before)
    assert.deepEqual([f.god.processIsDead, f.god.handleExit, f.god.forkMode], methods)
  }
})

test("cold registration revalidates restartProcessId after the observer await", async t => {
  const f = fixture(t)
  let closed = 0
  f.context.watchBootstrapExit = async pid => {
    f.god.restartProcessId = () => {
      throw new Error("replacement must not execute")
    }
    return {
      identities: [{ pid, created: "1", parentPid: f.context.daemonPid }],
      exited: new Promise(() => {}),
      close: async () => {
        closed++
      },
    }
  }
  await assert.rejects(
    f.register({ requestRestart: true }),
    /布置退出观察器期间|链|登记表|登记记录/,
  )
  assert.equal(closed, 1)
  assert.deepEqual(f.restarts, [])
})

test("a legal handoff nonce cannot invoke a replaced restartProcessId or announce a request", async t => {
  const f = fixture(t)
  await f.register({ requestRestart: true })
  let replacements = 0
  f.god.restartProcessId = () => {
    replacements++
  }
  f.child.emit("message", { type: "yunzai-guard-pm2-handoff", nonce: f.options.nonce })
  assert.equal(replacements, 0)
  assert.deepEqual(f.restarts, [])
  assert.equal(
    f.reports.some(event => event.event === "pm2-handoff-requested"),
    false,
  )
})

test("a stable readonly restartProcessId remains usable without being patched", async t => {
  const f = fixture(t)
  const original = f.god.restartProcessId
  Object.defineProperty(f.god, "restartProcessId", { value: original, writable: false })
  const result = await f.register({ requestRestart: true })
  assert.equal(result.status, "registered")
  f.child.emit("message", { type: "yunzai-guard-pm2-handoff", nonce: f.options.nonce })
  assert.deepEqual(f.restarts, [{ id: f.options.pmId }])
  assert.equal(f.god.restartProcessId, original)
})

test("unknown application entry Proxy is refused before prototype or own-key traps", async t => {
  const f = fixture(t)
  await f.register()
  let traps = 0
  const app = new Proxy(
    {},
    {
      getPrototypeOf() {
        traps++
        throw new Error("proxy entry trap")
      },
      ownKeys() {
        traps++
        throw new Error("proxy entry trap")
      },
    },
  )
  const registry = f.god[Symbol.for("yunzai-guard.pm2-daemon.resource.v1")]
  registry.applications.set(8, app)
  await assert.rejects(f.register(), /登记表|登记记录|代理记录/)
  assert.equal(traps, 0)
})

test("required application fields are own data and never inherited accessors", async t => {
  const f = fixture(t)
  await f.register()
  const registry = f.god[Symbol.for("yunzai-guard.pm2-daemon.resource.v1")]
  const app = { ...registry.applications.get(f.options.pmId), pmId: 8 }
  delete app.uniqueId
  registry.applications.set(8, app)
  let getters = 0
  assert.equal(Object.hasOwn(Object.prototype, "uniqueId"), false)
  Object.defineProperty(Object.prototype, "uniqueId", {
    configurable: true,
    get() {
      getters++
      return "inherited-identity"
    },
  })
  try {
    await assert.rejects(f.register(), /PM2 守护进程登记表不受支持/)
    assert.equal(getters, 0)
  } finally {
    delete Object.prototype.uniqueId
  }
})
