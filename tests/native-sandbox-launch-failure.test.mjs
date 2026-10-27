import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const errors = error =>
  error instanceof AggregateError
    ? error.errors.flatMap(errors)
    : [error instanceof Error ? error.message : error]

async function fixture(t, faults = {}) {
  const runs = path.join(repository, "tests/runs")
  fs.mkdirSync(runs, { recursive: true })
  const root = fs.mkdtempSync(path.join(runs, "native-launch-owned-failure-"))
  const native = path.join(root, "plugins/yunzai-guard/dist/native-sandbox")
  fs.mkdirSync(native, { recursive: true })
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}')
  const pluginRoot = path.join(root, "plugins/owned-fixture")
  fs.mkdirSync(pluginRoot)
  const entry = path.join(root, "entry.mjs")
  fs.writeFileSync(entry, "// self-authored; never executed in these mocked component cases\n")
  fs.writeFileSync(path.join(native, "preload.js"), "// not executed\n")
  const write = (name, source) => {
    const file = path.join(native, name)
    fs.writeFileSync(file, source)
    return pathToFileURL(file).href
  }
  const stateUrl = write("state.mjs", "export default { calls: [], runtimes: [] }\n")
  const state = (await import(stateUrl)).default
  Object.assign(state, faults)
  class OwnedChild extends EventEmitter {
    pid = 4321
    exitCode = null
    signalCode = null
    stdout = new PassThrough()
    stderr = new PassThrough()
    stdio = [null, null, null, new PassThrough(), null, new PassThrough()]
    kill(signal) {
      state.calls.push(`original-kill:${signal}`)
      if (state.killError) throw new Error(state.killError)
      if (state.killFalse) return false
      this.signalCode = signal
      queueMicrotask(() => this.emit("exit", null, signal))
      return true
    }
  }
  state.spawn = () => {
    state.calls.push("spawn")
    if (state.spawnError) throw new Error(state.spawnError)
    state.child = new OwnedChild()
    if (state.earlyError)
      queueMicrotask(() => state.child.emit("error", new Error(state.earlyError)))
    if (state.earlyExit)
      queueMicrotask(() => {
        state.child.exitCode = 0
        state.child.emit("exit", 0, null)
      })
    return state.child
  }
  const fsUrl = write(
    "mock-fs.mjs",
    `import fs from 'node:fs'; import state from ${JSON.stringify(stateUrl)};
export default { ...fs, mkdtempSync(prefix) { const directory=fs.mkdtempSync(prefix); state.runtimes.push(directory); return directory },
rmSync(target,options) { state.calls.push('runtime-rm'); if(state.rmError && state.runtimes.includes(target))throw new Error(state.rmError); return fs.rmSync(target,options) } }`,
  )
  const childUrl = write(
    "mock-child.mjs",
    `import state from ${JSON.stringify(stateUrl)}; export const spawn=(...args)=>state.spawn(...args)`,
  )
  const netUrl = write(
    "mock-net.mjs",
    `import {EventEmitter} from 'node:events'; import state from ${JSON.stringify(stateUrl)};
export default { createServer() { const server=new EventEmitter(); server.listening=false;
server.listen=(endpoint,callback)=>{ state.calls.push('server-listen'); queueMicrotask(()=>{if(state.listenError)server.emit('error',Object.assign(new Error(state.listenError),{code:'EADDRINUSE'}));else{server.listening=true;callback()}});return server };
server.close=callback=>{state.calls.push('server-close');const error=state.serverCloseError?new Error(state.serverCloseError):!server.listening?Object.assign(new Error('not listening'),{code:'ERR_SERVER_NOT_RUNNING'}):undefined;server.listening=false;queueMicrotask(()=>callback(error));return server};return server } }`,
  )
  const linuxUrl = write(
    "mock-linux.mjs",
    `import state from ${JSON.stringify(stateUrl)};
export function buildLinuxSandbox(root,settings,launch) { return { executable:'owned-component',args:[],env:{},cwd:root,extraStdio:[],
observe(child) {state.calls.push('observe');if('observeThrown' in state)throw state.observeThrown;if(state.observeError)throw new Error(state.observeError)},
dispose() {state.calls.push('dispose');if(state.disposeError)throw new Error(state.disposeError)},
async waitForExit(child) {state.calls.push('scope-wait');if(state.scopeError)throw new Error(state.scopeError)} } }`,
  )
  const transportUrl = write(
    "mock-transport.mjs",
    `import state from ${JSON.stringify(stateUrl)};
export function attachNativeTransport(child,stream,onError) {state.calls.push('attach');if(state.attachError)throw new Error(state.attachError);if(!state.earlyError&&!state.earlyExit)queueMicrotask(()=>child.emit('message',{type:'preload-hello'}))}`,
  )
  const windowsUrl = write(
    "mock-windows.mjs",
    "export function spawnWindowsSandbox(){throw new Error('Not exercised by the mocked Linux component path')}\n",
  )
  const privateUrl = write(
    "mock-private.mjs",
    "export const configuredPrivateWindowsRuntime=()=>undefined\n",
  )
  const behaviorUrl = write(
    "mock-behavior.mjs",
    "export const nativeBehaviorSettings=value=>value\n",
  )
  let source = fs.readFileSync(path.join(repository, "dist/native-sandbox/launch.js"), "utf8")
  for (const [from, to] of Object.entries({
    "node:fs": fsUrl,
    "node:net": netUrl,
    "node:child_process": childUrl,
    "./transport.js": transportUrl,
    "./config.js": pathToFileURL(path.join(repository, "dist/native-sandbox/config.js")).href,
    "./behavior.js": behaviorUrl,
    "../sandbox/linux.js": linuxUrl,
    "../sandbox/windows.js": windowsUrl,
    "../sandbox/windows-runtime.js": privateUrl,
    "../protect/objects.js": pathToFileURL(path.join(repository, "dist/protect/objects.js")).href,
    "../protect/paths.js": pathToFileURL(path.join(repository, "dist/protect/paths.js")).href,
    "../shared/messages.js": pathToFileURL(path.join(repository, "dist/shared/messages.js")).href,
  }))
    source = source.replaceAll(`from "${from}"`, `from ${JSON.stringify(to)}`)
  const moduleUrl = write("launch.mjs", source)
  const platform = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value: "linux", configurable: true })
  const api = await import(moduleUrl)
  t.after(() => {
    Object.defineProperty(process, "platform", platform)
    for (const directory of state.runtimes)
      if (fs.existsSync(directory)) {
        assert.equal(
          path.dirname(fs.realpathSync.native(directory)),
          fs.realpathSync.native(os.tmpdir()),
        )
        assert.ok(path.basename(directory).startsWith("yunzai-native-runtime-"))
        fs.rmSync(directory, { recursive: true })
      }
    assert.equal(path.dirname(fs.realpathSync.native(root)), fs.realpathSync.native(runs))
    assert.ok(path.basename(root).startsWith("native-launch-owned-failure-"))
    fs.rmSync(root, { recursive: true })
  })
  return {
    state,
    launch: () => api.launchNativeSandbox({ root, pluginRoot, entry, network: "none" }),
    cleanupConfirmed: api.nativeStartupCleanupConfirmed,
  }
}

test("native startup observation/attach and finally-dispose faults preserve originals and reclaim the original child", async t => {
  for (const faults of [
    { observeError: "observe fault", disposeError: "dispose fault" },
    { attachError: "attach fault" },
  ]) {
    await t.test(Object.keys(faults).join("+"), async childTest => {
      const f = await fixture(childTest, faults)
      await assert.rejects(f.launch(), error => {
        for (const value of Object.values(faults)) assert.ok(errors(error).includes(value))
        assert.equal(f.cleanupConfirmed(error), true)
        assert.equal(f.cleanupConfirmed(Object.assign(new Error(error.message), error)), false)
        return true
      })
      assert.equal(f.state.calls.filter(item => item.startsWith("original-kill:")).length, 1)
      assert.equal(f.state.calls.filter(item => item === "scope-wait").length, 1)
      assert.ok(f.state.calls.includes("dispose"))
      assert.ok(f.state.calls.includes("server-close"))
      assert.ok(f.state.runtimes.every(directory => !fs.existsSync(directory)))
    })
  }
})

test("native early error/exit rejects readiness and keeps a passive error receiver throughout cleanup", async t => {
  for (const faults of [{ earlyError: "original early error" }, { earlyExit: true }]) {
    await t.test(Object.keys(faults).join("+"), async childTest => {
      const f = await fixture(childTest, faults)
      const session = await f.launch()
      await assert.rejects(session.ready, /original early error|在传输就绪前退出/)
      await session.close()
      assert.ok(f.state.child.listenerCount("error") >= 1)
      assert.doesNotThrow(() => f.state.child.emit("error", new Error("late owned error")))
      assert.equal(f.state.calls.filter(item => item === "scope-wait").length, 1)
      assert.ok(f.state.runtimes.every(directory => !fs.existsSync(directory)))
    })
  }
})

test("native unknown scope and independent plumbing cleanup faults all survive while admission remains held", async t => {
  const f = await fixture(t, {
    observeError: "initial observe fault",
    scopeError: "scope unknown",
    serverCloseError: "server cleanup fault",
    rmError: "runtime cleanup fault",
  })
  await assert.rejects(f.launch(), error => {
    assert.equal(f.cleanupConfirmed(error), false)
    for (const message of [
      "initial observe fault",
      "scope unknown",
      "server cleanup fault",
      "runtime cleanup fault",
    ])
      assert.ok(errors(error).includes(message), message)
    return true
  })
  assert.ok(f.state.calls.includes("runtime-rm"))
  assert.ok(f.state.calls.includes("server-close"))
  assert.equal(f.state.calls.filter(item => item.startsWith("original-kill:")).length, 1)
  await assert.rejects(f.launch(), /此插件的沙箱已在运行/)
  assert.equal(f.state.calls.filter(item => item === "spawn").length, 1)
})

test("native failed listen never spawns and closes only its unused plumbing", async t => {
  const f = await fixture(t, { listenError: "original listen fault" })
  await assert.rejects(f.launch(), error => {
    assert.equal(f.cleanupConfirmed(error), true)
    return errors(error).includes("original listen fault")
  })
  assert.equal(f.state.calls.includes("spawn"), false)
  assert.ok(f.state.runtimes.every(directory => !fs.existsSync(directory)))
})

test("native falsy setup throws survive alongside finally disposal failure", async t => {
  for (const thrown of [undefined, null, false]) {
    await t.test(String(thrown), async childTest => {
      const f = await fixture(childTest, {
        observeThrown: thrown,
        disposeError: "independent disposal fault",
      })
      await assert.rejects(f.launch(), error => {
        assert.ok(errors(error).includes(thrown))
        assert.ok(errors(error).includes("independent disposal fault"))
        return true
      })
      assert.equal(f.state.calls.filter(item => item === "attach").length, 0)
      assert.equal(f.state.calls.filter(item => item === "scope-wait").length, 1)
      assert.ok(f.state.runtimes.every(directory => !fs.existsSync(directory)))
    })
  }
})

test("native rejected or throwing original kill still waits for scope and attempts plumbing cleanup", async t => {
  for (const faults of [{ killError: "original kill fault" }, { killFalse: true }]) {
    await t.test(Object.keys(faults).join("+"), async childTest => {
      const f = await fixture(childTest, { ...faults, scopeError: "independent unknown scope" })
      const session = await f.launch()
      await session.ready
      await assert.rejects(session.close(), error => {
        assert.ok(errors(error).includes(faults.killError ?? "原子进程结束请求未被接受"))
        assert.ok(errors(error).includes("independent unknown scope"))
        return true
      })
      assert.equal(f.state.calls.filter(item => item === "scope-wait").length, 1)
      assert.ok(f.state.calls.includes("server-close"))
      assert.ok(f.state.calls.includes("runtime-rm"))
      await assert.rejects(f.launch(), /此插件的沙箱已在运行/)
      assert.equal(f.state.calls.filter(item => item === "spawn").length, 1)
    })
  }
})

test("native successful startup releases admission only after one shared original cleanup", async t => {
  const f = await fixture(t)
  const first = await f.launch()
  await first.ready
  await assert.rejects(f.launch(), /此插件的沙箱已在运行/)
  const closing = first.close()
  assert.equal(closing, first.close())
  await closing
  const second = await f.launch()
  await second.ready
  await second.close()
  assert.equal(f.state.calls.filter(item => item === "spawn").length, 2)
  assert.equal(f.state.calls.filter(item => item === "scope-wait").length, 2)
})

test("受控构建入口拒绝伪造项目根和 Guard 代码可写范围", async () => {
  const [{ buildLinuxSandbox }, { spawnWindowsSandbox }, { launchNativeSandbox }] =
    await Promise.all([
      import("../dist/sandbox/linux.js"),
      import("../dist/sandbox/windows.js"),
      import("../dist/native-sandbox/launch.js"),
    ])
  const fake = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "guard-fake-root-"))
  const runtimeKey = Symbol.for("yunzai.guard.runtime.v1")
  const previousRuntime = Object.getOwnPropertyDescriptor(globalThis, runtimeKey)
  const previousPlatform = Object.getOwnPropertyDescriptor(process, "platform")
  const options = { executable: process.execPath, args: [], env: {}, runtimeManifest: "unused" }
  try {
    Object.defineProperty(globalThis, runtimeKey, { value: {}, configurable: true })
    Object.defineProperty(process, "platform", { value: "win32", configurable: true })
    let manifestReads = 0
    const invalidManifest = Object.defineProperty({ ...options }, "runtimeManifest", {
      get() {
        manifestReads++
        return { toString: () => assert.fail("不得转换清单路径对象") }
      },
    })
    assert.throws(() => spawnWindowsSandbox(fake, {}, invalidManifest), /运行时清单/)
    assert.equal(manifestReads, 1)
    assert.throws(
      () => spawnWindowsSandbox(fake, {}, { ...options, sessionKey: {} }),
      /会话密钥无效/,
    )
    assert.throws(() => spawnWindowsSandbox(fake, {}, options), /可写路径须为项目内目录/)
    assert.throws(
      () => spawnWindowsSandbox(repository, { sandbox: { writablePaths: ["src"] } }, options),
      /可写路径须为项目内目录/,
    )
    Object.defineProperty(process, "platform", { value: "linux", configurable: true })
    assert.throws(() => buildLinuxSandbox(fake, {}, options), /沙箱可写/)
    await assert.rejects(
      launchNativeSandbox({ root: fake, pluginRoot: fake, entry: "unused", network: "none" }),
      /插件沙箱需要/,
    )
    assert.deepEqual(fs.readdirSync(fake), [])
  } finally {
    Object.defineProperty(process, "platform", previousPlatform)
    if (previousRuntime) Object.defineProperty(globalThis, runtimeKey, previousRuntime)
    else Reflect.deleteProperty(globalThis, runtimeKey)
    assert.equal(path.dirname(fake), fs.realpathSync.native(os.tmpdir()))
    fs.rmSync(fake, { recursive: true })
  }
})
