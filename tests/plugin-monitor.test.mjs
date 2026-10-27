import assert from "node:assert/strict"
import test from "node:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { PluginMonitor } from "../dist/monitor/plugin.js"
import { parseSettings } from "../dist/config/index.js"
import { installHookWatch } from "../dist/monitor/watch.js"

function fixture(rules = [], watch) {
  const storage = new AsyncLocalStorage()
  const events = []
  let checks = 0
  const monitor = new PluginMonitor(
    { settings: parseSettings({ rules }), run: (name, fn) => storage.run(name, fn) },
    event => events.push(event),
    () => checks++,
    watch,
    () => storage.getStore(),
  )
  const loader = {
    priority: [],
    importPlugin(file) {
      return this.loadPlugin(file, file.constructor)
    },
    loadPlugin(file, Constructor) {
      const instance = new Constructor()
      instance.init?.()
      this.priority.push({ plugin: instance, key: file.name })
      this.registerHandlers(instance)
      return instance
    },
    registerHandlers(instance) {
      this.handler = instance.handle
    },
    collectTask(task) {
      return task
    },
  }
  monitor.attach(loader)
  return { storage, events, monitor, loader, checks: () => checks }
}

test("loader-owned prototypes and instances observe hooks without requiring ESM exports", () => {
  const watch = installHookWatch()
  const f = fixture([], watch)
  class Business {
    handle() {
      return 1
    }
  }
  try {
    const instance = f.loader.importPlugin({ name: "commonjs", constructor: Business })
    f.storage.run("editor", () => {
      Object.defineProperty(Business.prototype, "handle", { value: () => 9 })
      Reflect.set(instance, "handle", () => 7)
    })
    assert.equal(instance.handle(), 7)
    const hooks = f.events.filter(event => event.operation === "plugin-function-hook")
    assert.equal(hooks.length, 2)
    assert.ok(hooks.every(event => event.plugin === "editor" && event.action === "audit"))
  } finally {
    watch.close()
  }
})

test("business methods preserve this, return values, Promise identity, errors, and async attribution", async () => {
  const f = fixture()
  const promise = Promise.resolve("result")
  const failure = new Error("original error")
  const thenable = Object.defineProperty({}, "then", {
    get() {
      throw failure
    },
  })
  class Business {
    value = 41
    handle = () => this.value + 1
    result(value) {
      return value
    }
    fail() {
      throw failure
    }
    async delayed() {
      await new Promise(resolve => setTimeout(resolve, 5))
      return f.storage.getStore()
    }
  }
  const originalResult = Business.prototype.result
  const instance = f.loader.importPlugin({ name: "business", constructor: Business })
  assert.notEqual(Business.prototype.result, originalResult)
  assert.equal(f.monitor.originalFunction(Business.prototype.result), originalResult)
  assert.equal(f.monitor.originalFunction(originalResult), originalResult)
  assert.equal(f.loader.handler(), 42)
  assert.equal(instance.result(promise), promise)
  assert.equal(instance.result(thenable), thenable)
  assert.throws(
    () => instance.fail(),
    error => error === failure,
  )
  assert.equal(await instance.delayed(), "business")
  assert.equal(f.storage.getStore(), undefined)
  assert.equal(f.checks(), 14)
  assert.deepEqual(f.monitor.snapshot().entries[0], {
    name: "business",
    imports: 1,
    loads: 1,
    registered: 1,
    calls: 5,
    blocked: 0,
    unwrapped: 0,
  })
  assert.equal(JSON.stringify(f.events).includes("original error"), false)
})

test("business rule blocks a side effect before invocation and emits restart decision", () => {
  const f = fixture([
    {
      id: "deny-send",
      kind: "plugin",
      plugin: "business",
      operation: "plugin.call",
      target: "send",
      action: "restart",
    },
  ])
  let sideEffects = 0
  class Business {
    send() {
      sideEffects++
    }
  }
  const instance = f.loader.loadPlugin({ name: "business" }, Business)
  assert.throws(() => instance.send(), { code: "GUARD_DENIED" })
  assert.equal(sideEffects, 0)
  assert.equal(f.events.at(-1).action, "restart")
  assert.equal(f.monitor.snapshot().entries[0].blocked, 1)
})

test("task callbacks preserve receiver and propagate plugin identity to later async work", async () => {
  const f = fixture()
  const task = {
    value: 42,
    async fnc() {
      await new Promise(resolve => setTimeout(resolve, 5))
      return [this.value, f.storage.getStore()]
    },
  }
  assert.equal(f.loader.collectTask(task, "task", "business"), task)
  assert.deepEqual(await task.fnc(), [42, "business"])
  assert.equal(f.events.at(-1).operation, "plugin.task")
})

test("shared class instances retain their own plugin owner and frozen methods remain usable", () => {
  const f = fixture()
  class Business {
    constructor() {
      Object.defineProperty(this, "frozen", { value: () => 42 })
    }
    run() {
      return f.storage.getStore()
    }
  }
  const a = f.loader.loadPlugin({ name: "a" }, Business)
  const b = f.loader.loadPlugin({ name: "b" }, Business)
  assert.equal(a.run(), "a")
  assert.equal(b.run(), "b")
  assert.equal(a.frozen(), 42)
  assert.equal(f.monitor.snapshot().entries[0].unwrapped, 1)
})

test("inventory has a bound but overflow plugins still obey policy", () => {
  const f = fixture([
    { id: "block-import", kind: "plugin", operation: "plugin.import", action: "deny" },
  ])
  for (let i = 0; i < 150; i++)
    assert.throws(() => f.loader.importPlugin({ name: `plugin-${i}` }), { code: "GUARD_DENIED" })
  assert.equal(f.monitor.snapshot().entries.length, 128)
  assert.equal(f.monitor.snapshot().truncated, true)
  assert.equal(f.events.length, 150)
})

test("fresh message instances keep constructor identity and monitor instance arrow handlers", () => {
  const f = fixture([{ id: "block-arrow", kind: "plugin", target: "handle", action: "deny" }])
  let effect = 0
  let constructorOwner
  class Business {
    constructor(event) {
      assert.equal(new.target, Business)
      this.event = event
      constructorOwner = f.storage.getStore()
    }
    handle = () => effect++
  }
  const event = { message: "private" }
  const instance = f.monitor.construct(Business, [event], "business")
  assert.ok(instance instanceof Business)
  assert.equal(instance.constructor, Business)
  assert.equal(instance.event, event)
  assert.equal(constructorOwner, "business")
  assert.throws(() => instance.handle(), { code: "GUARD_DENIED" })
  assert.equal(effect, 0)
  assert.equal(JSON.stringify(f.events).includes("private"), false)
})
