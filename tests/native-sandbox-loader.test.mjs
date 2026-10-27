import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const moduleRoot = path.resolve(process.env.GUARD_TEST_MODULE_ROOT ?? path.join(repository, "dist"))
const { NativePluginLoader } = await import(
  pathToFileURL(path.join(moduleRoot, "native-sandbox/loader.js"))
)
const { parseSettings } = await import(pathToFileURL(path.join(moduleRoot, "config/index.js")))

function descriptor(overrides = {}) {
  return {
    id: "index.js#Fixture",
    name: "Fixture",
    methods: ["answer"],
    metadata: {
      name: "Fake host fixture",
      event: "message",
      priority: 10,
      namespace: "victim-namespace",
      rule: [{ reg: "^test$", fnc: "answer" }],
      task: [{ name: "fake scheduled task", cron: "* * * * * *", fnc: "answer" }],
      handler: [{ key: "shared-handler", fn: "answer" }],
    },
    ...overrides,
  }
}

function fixture(t, selected = true, configure) {
  const runs = path.join(repository, "tests/runs")
  fs.mkdirSync(runs, { recursive: true })
  const root = fs.mkdtempSync(path.join(runs, "native-loader-fake-"))
  const pluginRoot = path.join(root, "plugins/sandboxed")
  fs.mkdirSync(pluginRoot, { recursive: true })
  fs.mkdirSync(path.join(root, "lib/plugins"), { recursive: true })
  const source = "// Deliberately never imported: this fixture exercises only the trusted loader.\n"
  fs.writeFileSync(path.join(pluginRoot, "index.js"), source)
  const originalGlobals = Object.fromEntries(
    ["plugin", "logger"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  )
  const history = [],
    requests = [],
    logs = [],
    audits = []
  let inheritedCalls = 0
  class Base {
    constructor(options) {
      Object.assign(this, options)
    }
    reply() {
      inheritedCalls++
      throw new Error("Inherited host reply must not run")
    }
    renderImg() {
      inheritedCalls++
      throw new Error("Inherited host renderer must not run")
    }
  }
  Object.defineProperty(globalThis, "plugin", { value: Base, configurable: true, writable: true })
  Object.defineProperty(globalThis, "logger", {
    value: {
      error: message => logs.push({ level: "error", message }),
      warn: message => logs.push({ level: "warn", message }),
    },
    configurable: true,
    writable: true,
  })
  const settings = parseSettings({
    pluginSandbox: { native: { plugins: selected ? [{ id: "sandboxed" }] : [] } },
  })
  const manager = new NativePluginLoader(root, settings, event => audits.push(event))
  const file = { name: "sandboxed", path: "../../plugins/sandboxed/index.js" }
  const legacyImportResult = { legacy: "import" },
    legacyChangeResult = { legacy: "change" }
  const originalImports = [],
    originalChanges = []
  const victim = { key: "victim-plugin", namespace: "victim-namespace", fn: () => "victim" }
  const loader = {
    priority: [],
    task: [],
    taskMap: new Map(),
    pluginCountMap: new Map(),
    load_time: {},
    handlers: new Map([["victim-namespace:shared-handler", victim]]),
    async importPlugin(...args) {
      originalImports.push({ receiver: this, args })
      return legacyImportResult
    },
    changePlugin(...args) {
      originalChanges.push({ receiver: this, args })
      return legacyChangeResult
    },
    async loadPlugin(file, Constructor) {
      const init = new Constructor()
      if (init.init && (await init.init()) === "return") return
      const tasks = (Array.isArray(init.task) ? init.task : [init.task]).filter(Boolean)
      this.task.push(...tasks)
      this.taskMap.set(file.name, new Set([...(this.taskMap.get(file.name) ?? []), ...tasks]))
      const plugin = new Constructor()
      this.priority.push({
        key: file.name,
        class: Constructor,
        plugin,
        namespace: plugin.namespace,
      })
      this.pluginCountMap.set(file.name, (this.pluginCountMap.get(file.name) ?? 0) + 1)
      for (const handler of plugin.handler ?? []) {
        const key = `${plugin.namespace}:${handler.key}`
        this.handlers.delete(key) // 模拟核心 Handler.add 替换命名空间的行为。
        this.handlers.set(key, {
          key: file.name,
          namespace: plugin.namespace,
          fn: plugin[handler.fn],
        })
      }
      history.push(`registered:${file.name}`)
    },
    async unloadPlugin(key) {
      history.push(`unload:${key}`)
      const tasks = this.taskMap.get(key) ?? new Set()
      this.task = this.task.filter(task => !tasks.has(task))
      this.taskMap.delete(key)
      this.priority = this.priority.filter(item => item.key !== key)
      for (const [id, handler] of this.handlers) if (handler.key === key) this.handlers.delete(id)
      this.pluginCountMap.delete(key)
    },
  }
  let closed = 0,
    loadCalls = 0,
    taskCalls = 0
  const fakeClient = {
    pluginRoot,
    config: { id: "sandboxed" },
    descriptors: [descriptor()],
    consumeTask() {
      taskCalls++
    },
    async load(entry) {
      loadCalls++
      assert.equal(entry, path.join(pluginRoot, "index.js"))
      return { classes: this.descriptors, pid: 1 }
    },
    async request(type, values, event, capabilities) {
      requests.push({ type, values, event, ...(capabilities ? { capabilities } : {}) })
      return type === "native-match"
        ? true
        : type === "native-context"
          ? {}
          : { result: "guest-result" }
    },
    async close() {
      if (!closed) {
        closed++
        history.push("guest-close")
      }
    },
    async releaseInstances(instances) {
      await this.request("native-release-instances", { instances })
    },
  }
  // 仅在测试中注入编译后的 TypeScript 私有字段，不启动系统进程。
  if (selected) manager.clients.set("sandboxed", fakeClient)
  configure?.({ root, loader })
  manager.attach(loader)
  t.after(async () => {
    try {
      await manager.close()
      assert.equal(fs.readFileSync(path.join(pluginRoot, "index.js"), "utf8"), source)
    } finally {
      for (const [key, original] of Object.entries(originalGlobals)) {
        if (original) Object.defineProperty(globalThis, key, original)
        else delete globalThis[key]
      }
      const resolved = fs.realpathSync.native(root)
      if (
        path.dirname(resolved) !== fs.realpathSync.native(runs) ||
        !path.basename(resolved).startsWith("native-loader-fake-")
      )
        throw new Error("Refusing unsafe fake loader fixture cleanup")
      fs.rmSync(resolved, { recursive: true, force: true })
    }
  })
  return {
    manager,
    settings,
    audits,
    loader,
    fakeClient,
    file,
    history,
    requests,
    logs,
    victim,
    originalImports,
    originalChanges,
    legacyImportResult,
    legacyChangeResult,
    inheritedCalls: () => inheritedCalls,
    closeCount: () => closed,
    loadCalls: () => loadCalls,
    taskCalls: () => taskCalls,
  }
}

test("native constructors keep original names while instances retain their display names", t => {
  const f = fixture(t)
  for (const name of ["OriginalClass", ""]) {
    const Proxy = f.manager.constructorProxy(f.fakeClient, descriptor({ name }))
    const instance = new Proxy()
    assert.equal(Proxy.name, name)
    assert.equal(instance.constructor.name, name)
    assert.equal(instance.name, "Fake host fixture")
  }
  assert.equal(f.requests.length, 0)
  assert.equal(f.inheritedCalls(), 0)
})

test("native namespaces are unique host-owned UUIDs and cannot replace another plugin's handlers", async t => {
  const f = fixture(t)
  assert.equal(await f.loader.importPlugin(f.file), true)
  const namespace = f.loader.priority[0].namespace
  assert.match(namespace, /^guard-native-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
  assert.notEqual(namespace, "victim-namespace")
  assert.equal(f.loader.handlers.get("victim-namespace:shared-handler"), f.victim)
  const Other = f.manager.constructorProxy(f.fakeClient, descriptor({ id: "index.js#Other" }))
  assert.notEqual(new Other().namespace, namespace)
  assert.equal(new Other().namespace, new Other().namespace)
  assert.equal(f.originalImports.length, 0)
})

test("native handler metadata cannot dispatch inherited host reply or renderer methods", t => {
  const f = fixture(t)
  for (const fn of ["reply", "renderImg"]) {
    const value = descriptor()
    value.metadata.handler = [{ key: "shared-handler", fn }]
    assert.throws(() => f.manager.constructorProxy(f.fakeClient, value), /处理器须引用插件进程方法/)
  }
  assert.equal(f.inheritedCalls(), 0)
  assert.equal(f.requests.length, 0)
  assert.equal(f.loader.handlers.get("victim-namespace:shared-handler"), f.victim)
})

test("missing-rule aliases preserve Host namespace and never install the original field name", async t => {
  const f = fixture(t),
    alias = "guardMissingRule_11111111111111111111111111111111"
  const value = descriptor({
    methods: [alias],
    metadata: {
      name: "Missing namespace",
      event: "message",
      priority: 10,
      rule: [{ reg: "^namespace$", fnc: alias }],
    },
  })
  f.fakeClient.request = async (type, values) => {
    f.requests.push({ type, values })
    return { result: null }
  }
  const Proxy = f.manager.constructorProxy(f.fakeClient, value)
  const instance = new Proxy()
  assert.match(instance.namespace, /^guard-native-/)
  assert.equal(Object.hasOwn(Proxy.prototype, "namespace"), false)
  instance.e = { msg: "namespace" }
  assert.equal(await instance[instance.rule[0].fnc](instance.e), null)
  assert.equal(f.requests.at(-1).values.method, alias)
  assert.equal(f.inheritedCalls(), 0)
  value.metadata.rule[0].fnc = "namespace"
  assert.throws(
    () => f.manager.constructorProxy(f.fakeClient, value),
    /规则须引用已登记的插件方法：namespace/,
  )
})

test("forged listed base method names still dispatch RPC and never fall through to HostBase", async t => {
  const f = fixture(t),
    value = descriptor()
  value.methods.push("reply", "renderImg")
  const Proxy = f.manager.constructorProxy(f.fakeClient, value),
    instance = new Proxy()
  instance.e = { msg: "probe" }
  assert.equal(await instance.reply("text"), "guest-result")
  assert.equal(await instance.renderImg("image"), "guest-result")
  assert.deepEqual(
    f.requests.map(request => request.values.method),
    ["reply", "renderImg"],
  )
  assert.equal(f.inheritedCalls(), 0)
})

test("only one extra internal alias slot can accompany 256 advertised business methods", t => {
  const f = fixture(t),
    value = descriptor()
  value.methods = [
    "answer",
    ...Array.from({ length: 255 }, (_, index) => `method_${index}`),
    "guardMissingRule_11111111111111111111111111111111",
  ]
  assert.doesNotThrow(() => f.manager.constructorProxy(f.fakeClient, value))
  value.methods[256] = "extraBusinessMethod"
  assert.throws(
    () => f.manager.constructorProxy(f.fakeClient, value),
    /额外方法位保留给缺省规则别名/,
  )
  value.methods.push("guardMissingRule_11111111111111111111111111111111")
  assert.throws(() => f.manager.constructorProxy(f.fakeClient, value), /独立插件方法列表无效/)
})

test("original infinite plugin and Handler priorities retain host ordering without general nonfinite DTOs", async t => {
  const f = fixture(t)
  const item = descriptor()
  item.metadata.priority = { $type: "NativePriority", value: "negative-infinity" }
  item.metadata.handler[0].priority = { $type: "NativePriority", value: "positive-infinity" }
  f.fakeClient.descriptors = [item]
  assert.equal(await f.loader.importPlugin(f.file), true)
  const proxy = f.loader.priority[0].plugin
  assert.equal(proxy.priority, -Infinity)
  assert.equal(proxy.handler[0].priority, Infinity)
  assert.deepEqual(
    [0, proxy.priority, 100].sort((a, b) => a - b),
    [-Infinity, 0, 100],
  )
})

test("native rule syntax and matching remain in the child; ordinary rules keep their local fallback", async t => {
  const f = fixture(t)
  const value = descriptor()
  value.metadata.rule[0].reg = { $type: "RegExp", source: "[", flags: "gg" }
  const Proxy = f.manager.constructorProxy(f.fakeClient, value)
  const instance = new Proxy()
  const marker = instance.rule[0].reg
  assert.equal(marker.source, "(?:)")
  marker.test = () => assert.fail("Native matching must not invoke host RegExp.test")
  assert.equal(await f.manager.testRule(marker, "message"), true)
  assert.deepEqual(f.requests.at(-1), {
    type: "native-match",
    values: { classId: value.id, ruleIndex: 0, text: "message" },
    event: undefined,
  })
  f.fakeClient.request = async () => false
  assert.equal(await f.manager.testRule(marker, "message"), false)
  f.fakeClient.request = async () => "true"
  await assert.rejects(f.manager.testRule(marker, "message"), /匹配结果无效/)
  assert.equal(await f.manager.testRule(/^local$/, "local"), true)
  assert.equal(await f.manager.testRule(/^local$/, "other"), false)
})

test("玖璃规则捕获只在插件进程执行，普通规则保留参数数量", async t => {
  const f = fixture(t)
  const Proxy = f.manager.constructorProxy(f.fakeClient, descriptor())
  const instance = new Proxy()
  const event = { msg: "#test 42" }
  instance.e = event
  instance.rule[0].reg.exec = () => assert.fail("占位正则不能在本体执行")
  await instance.answer(...f.manager.ruleArgs(instance.answer, instance.rule[0].reg, event))
  const call = f.requests.at(-1)
  assert.equal(call.values.ruleIndex, 0)
  assert.equal(call.event, event)
  assert.equal("eventArgs" in call.values, false)
  assert.deepEqual(
    f.manager.ruleArgs(() => {}, /test/, event),
    [event],
  )
  const args = f.manager.ruleArgs(function (_event, _match) {}, /test (\d+)/, event)
  assert.equal(args[1][1], "42")
  const Other = f.manager.constructorProxy(
    { ...f.fakeClient, config: { id: "other" } },
    descriptor(),
  )
  const other = new Other()
  other.e = event
  await assert.rejects(
    other.answer(...f.manager.ruleArgs(instance.answer, instance.rule[0].reg, event)),
    /规则没有已登记的方法/,
  )
})

test("玖璃实例回收失败关闭所属插件并发出宿主强制恢复事件", async t => {
  const f = fixture(t, true, ({ root, loader }) => {
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"jiuli"}')
    fs.mkdirSync(path.join(root, "lib/core"), { recursive: true })
    fs.writeFileSync(path.join(root, "lib/core/loader.js"), "")
    loader.deal = async function (event) {
      const instance = new this.priority[0].class()
      instance.e = event
      return instance.answer(event)
    }
  })
  await f.loader.importPlugin(f.file)
  const originalRequest = f.fakeClient.request
  f.fakeClient.request = function (type, ...args) {
    if (type === "native-release-instances") throw new Error("release unavailable")
    return originalRequest.call(this, type, ...args)
  }
  await assert.rejects(f.loader.deal({ msg: "test" }), /插件消息实例回收未确认/)
  assert.equal(f.closeCount(), 1)
  const { authorizeHostEvent } = await import(
    pathToFileURL(path.join(moduleRoot, "host/event-policy.js"))
  )
  const event = f.audits.find(item => item.operation === "native.cleanup-unconfirmed")
  assert.equal(event.plugin, "sandboxed")
  assert.equal(event.target, "sandboxed")
  assert.equal(authorizeHostEvent(f.settings, event).action, "restart")
})

test("玖璃共享 Handler 实例按消息隔离，并发及失败分发均释放自己的实例", async t => {
  let f
  f = fixture(t, true, ({ root, loader }) => {
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"jiuli"}')
    fs.mkdirSync(path.join(root, "lib/core"), { recursive: true })
    fs.writeFileSync(path.join(root, "lib/core/loader.js"), "")
    loader.deal = async function (event) {
      const instance = this.priority[0].plugin
      const handler = instance[instance.handler[0].fn]
      await handler(event)
      await Promise.resolve()
      await handler(event)
      if (event.fail) throw new Error("fixture dispatch failed")
      return event.msg
    }
  })
  await f.loader.importPlugin(f.file)
  assert.deepEqual(
    await Promise.all([f.loader.deal({ msg: "one" }), f.loader.deal({ msg: "two" })]),
    ["one", "two"],
  )
  await assert.rejects(f.loader.deal({ msg: "failed", fail: true }), /fixture dispatch failed/)
  const calls = f.requests.filter(item => item.type === "native-call")
  const instances = new Map()
  for (const call of calls) {
    assert.match(call.values.instanceId, /^[0-9a-f-]{36}$/)
    const seen = instances.get(call.event.msg)
    if (seen) assert.equal(call.values.instanceId, seen)
    else instances.set(call.event.msg, call.values.instanceId)
  }
  assert.equal(new Set(instances.values()).size, 3)
  const released = f.requests.filter(item => item.type === "native-release-instances")
  assert.equal(released.length, 3)
  assert.deepEqual(
    new Set(released.flatMap(item => item.values.instances.map(value => value.instanceId))),
    new Set(instances.values()),
  )
})

test("a later invalid class rolls back earlier priority, task and handler entries without host import", async t => {
  const f = fixture(t)
  const invalid = descriptor({ id: "index.js#Invalid" })
  invalid.methods.push("init")
  f.fakeClient.descriptors = [descriptor(), invalid]
  const originalRequest = f.fakeClient.request
  f.fakeClient.request = async function (type, values, ...args) {
    if (type === "native-call" && values.classId === invalid.id && values.method === "init")
      return {
        result: null,
        metadata: { ...invalid.metadata, handler: [{ key: "shared-handler", fn: "renderImg" }] },
      }
    return Reflect.apply(originalRequest, this, [type, values, ...args])
  }
  assert.equal(await f.loader.importPlugin(f.file), false)
  assert.ok(
    f.history.includes("registered:sandboxed"),
    "The valid first class must actually register before failure",
  )
  assert.deepEqual(f.loader.priority, [])
  assert.deepEqual(f.loader.task, [])
  assert.equal(f.loader.taskMap.size, 0)
  assert.equal(f.loader.handlers.size, 1)
  assert.equal(f.loader.handlers.get("victim-namespace:shared-handler"), f.victim)
  assert.equal(f.closeCount(), 1)
  assert.ok(f.history.indexOf("unload:sandboxed") < f.history.indexOf("guest-close"))
  assert.equal(f.originalImports.length, 0)
  assert.equal(
    await f.loader.importPlugin(f.file),
    false,
    "A failed plugin stays disabled until restart",
  )
  assert.equal(f.loadCalls(), 1)
  assert.equal(f.originalImports.length, 0)
})

test("selected hot reload retains the current instance instead of entering the core private unload path", async t => {
  const f = fixture(t)
  assert.equal(await f.loader.importPlugin(f.file), true)
  const instance = f.loader.priority[0]
  const tasks = [...f.loader.task]
  assert.equal(await f.loader.changePlugin("sandboxed"), false)
  assert.equal(f.loader.priority[0], instance)
  assert.deepEqual(f.loader.task, tasks)
  assert.equal(f.originalChanges.length, 0)
  assert.equal(f.closeCount(), 0)
  assert.ok(f.logs.some(row => row.level === "warn" && /重启/.test(row.message)))
})

test("no native selection preserves original import and change dispatch", async t => {
  const f = fixture(t, false)
  const errors = []
  assert.equal(await f.loader.importPlugin(f.file, errors), f.legacyImportResult)
  assert.equal(f.originalImports.length, 1)
  assert.equal(f.originalImports[0].receiver, f.loader)
  assert.equal(f.originalImports[0].args[0], f.file)
  assert.equal(f.originalImports[0].args[1], errors)
  assert.equal(f.loader.changePlugin("sandboxed", "argument"), f.legacyChangeResult)
  assert.equal(f.originalChanges.length, 1)
  assert.deepEqual(f.originalChanges[0].args, ["sandboxed", "argument"])
  assert.equal(f.closeCount(), 0)
  assert.equal(f.loadCalls(), 0)
})

test("manager close unregisters host tasks and handlers before retiring the guest", async t => {
  const f = fixture(t)
  assert.equal(await f.loader.importPlugin(f.file), true)
  await f.manager.close()
  assert.ok(f.history.indexOf("unload:sandboxed") < f.history.indexOf("guest-close"))
  assert.deepEqual(f.loader.priority, [])
  assert.deepEqual(f.loader.task, [])
  assert.equal(f.loader.handlers.size, 1)
  assert.equal(f.loader.handlers.get("victim-namespace:shared-handler"), f.victim)
  assert.equal(f.closeCount(), 1)
  await f.manager.close()
  assert.equal(f.closeCount(), 1)
})

test("native handler wrappers preserve tail values and keep the reject function in the trusted host", async t => {
  const state = fixture(t)
  assert.equal(await state.loader.importPlugin(state.file), true)
  const instance = state.loader.priority[0].plugin
  const event = { msg: "handler message" },
    args = { value: 42 },
    reject = () => {}
  await instance[instance.handler[0].fn](event, args, reject)
  const request = state.requests.at(-1)
  assert.equal(request.event, event)
  assert.deepEqual(request.values.eventArgs, [args])
  assert.equal(request.values.handlerReject, true)
  assert.equal(request.values.method, "answer")
  assert.equal(request.capabilities.handlerReject, reject)
  assert.equal(Object.hasOwn(request.values, "args"), false)
  assert.equal(JSON.stringify(request.values).includes("function"), false)
})

test("guest display names cannot select another host plugin's conversation context", async t => {
  const state = fixture(t)
  const Base = globalThis.plugin
  const contexts = new Map()
  class ContextBase extends Base {
    conKey() {
      return `${this.name}.${this.e.self_id}.${this.e.user_id}`
    }
    getContext() {
      return contexts.get(this.conKey())
    }
  }
  Object.defineProperty(globalThis, "plugin", {
    value: ContextBase,
    configurable: true,
    writable: true,
  })
  const event = { self_id: "bot", user_id: "user", msg: "context response" }
  const victim = new ContextBase({ name: "same display name" })
  victim.e = event
  const privateContext = { answer: { msg: "host plugin context", reply() {} } }
  contexts.set(victim.conKey(), privateContext)
  assert.equal(victim.getContext(), privateContext)
  state.fakeClient.descriptors[0].metadata.name = victim.name
  assert.equal(await state.loader.importPlugin(state.file), true)
  const native = state.loader.priority[0].plugin
  native.e = event
  assert.notEqual(
    await native.getContext(),
    privateContext,
    "Native host proxy must not borrow contexts by matching a guest-controlled display name",
  )
  assert.equal(victim.getContext(), privateContext, "Victim context must remain intact")
})

function fullTaskDescriptor(init = false) {
  const item = descriptor()
  if (init) item.methods.push("init")
  item.metadata.task = Array.from({ length: 64 }, (_, index) => ({
    name: `scheduled-${index}`,
    cron: "* * * * * *",
    fnc: "answer",
  }))
  return item
}

test("初始化动态规则同步受校验的方法，消息回调不能扩展宿主代理", async t => {
  const f = fixture(t)
  const item = descriptor({ methods: ["answer", "init"] })
  f.fakeClient.descriptors = [item]
  const metadata = {
    ...item.metadata,
    rule: [...item.metadata.rule, { reg: "^dynamic$", fnc: "dynamicRule" }],
  }
  f.fakeClient.request = async (type, values, event) => {
    f.requests.push({ type, values, event })
    return {
      result: "guest-result",
      metadata,
      methods:
        values.method === "init"
          ? [...item.methods, "dynamicRule"]
          : [...item.methods, "dynamicRule", "lateMethod"],
    }
  }
  assert.equal(await f.loader.importPlugin(f.file), true)
  const instance = f.loader.priority[0].plugin
  assert.equal(instance.rule[1].fnc, "dynamicRule")
  assert.equal(typeof instance.dynamicRule, "function")
  instance.e = { msg: "dynamic" }
  assert.equal(await instance.dynamicRule(instance.e), "guest-result")
  assert.equal(f.requests.at(-1).values.method, "dynamicRule")
  assert.equal(instance.lateMethod, undefined)
})

for (const method of ["answer", "init"])
  test(`runtime ${method} metadata cannot discount already installed host jobs`, async t => {
    const f = fixture(t),
      item = fullTaskDescriptor(method === "init")
    f.fakeClient.descriptors = [item]
    let initialization = 0
    f.fakeClient.request = async (_type, values) => ({
      result: "guest-result",
      metadata:
        method === "init" && values.method === "init" && initialization++ === 0
          ? item.metadata
          : { ...item.metadata, task: [] },
    })
    assert.equal(await f.loader.importPlugin(f.file), true)
    assert.equal(f.loader.task.length, 64)
    const instance = f.loader.priority[0].plugin
    instance.e = { msg: "runtime call" }
    await instance[method](instance.e)
    const extra = descriptor({ id: "other.js#Extra" })
    assert.throws(
      () => f.manager.registrations.reserve("sandboxed", "sandboxed/other.js", [extra]),
      /独立插件登记数超限：sandboxed/,
    )
    assert.equal(f.loader.task.length, 64)
  })

test("fatal native retirement removes host jobs and handlers while retaining unrelated plugins", async t => {
  const f = fixture(t)
  f.fakeClient.descriptors = [fullTaskDescriptor()]
  assert.equal(await f.loader.importPlugin(f.file), true)
  await f.manager.retire("sandboxed")
  assert.deepEqual(f.loader.priority, [])
  assert.deepEqual(f.loader.task, [])
  assert.equal(f.loader.taskMap.size, 0)
  assert.equal(f.loader.handlers.size, 1)
  assert.equal(f.loader.handlers.get("victim-namespace:shared-handler"), f.victim)
  assert.equal(f.manager.failedPlugins.has("sandboxed"), true)
  f.manager.registrations.reserve("sandboxed", "sandboxed/proof.js", [fullTaskDescriptor()])
  f.manager.registrations.release("sandboxed")
})

test("unconfirmed host retirement retains scheduler quota until cleanup succeeds", async t => {
  const f = fixture(t)
  f.fakeClient.descriptors = [fullTaskDescriptor()]
  assert.equal(await f.loader.importPlugin(f.file), true)
  const originalUnload = f.manager.originalUnload
  f.manager.originalUnload = async () => {
    throw new Error("benign cleanup failure")
  }
  try {
    await assert.rejects(f.manager.retire("sandboxed"), /撤销|清理/)
    assert.equal(f.loader.task.length, 64)
    assert.throws(
      () =>
        f.manager.registrations.reserve("sandboxed", "sandboxed/extra.js", [
          descriptor({ id: "extra" }),
        ]),
      /独立插件登记数超限：sandboxed/,
    )
    assert.ok(f.manager.loadedFiles.get("sandboxed")?.has("sandboxed"))
  } finally {
    f.manager.originalUnload = originalUnload
  }
})

test("host task wrappers charge each string-method and callback invocation before RPC", async t => {
  const f = fixture(t)
  const item = descriptor()
  item.metadata.task = [
    { name: "string-method", cron: "* * * * * *", fnc: "answer" },
    { name: "callback", cron: "* * * * * *", fnc: { $type: "NativeFunction", id: "cb-fixture" } },
  ]
  f.fakeClient.descriptors = [item]
  assert.equal(await f.loader.importPlugin(f.file), true)
  for (const task of f.loader.task) await task.fnc()
  assert.equal(f.taskCalls(), 2)
  assert.equal(
    f.requests.filter(row => ["native-call", "native-callback"].includes(row.type)).length,
    2,
  )
})
