import assert from "node:assert/strict"
import test from "node:test"
import { EventEmitter } from "node:events"
import { installHookWatch } from "../dist/monitor/watch.js"
import { IntegrityMonitor } from "../dist/monitor/integrity.js"
import { parseSettings } from "../dist/config/index.js"
import { authorizeHostEvent } from "../dist/host/event-policy.js"

const originalDefine = Object.defineProperty

test("自定义清单记录继承的 emit Hook，保留监听器、返回值和业务效果", () => {
  class Emitter extends EventEmitter {}
  const bot = new Emitter()
  const originalEmit = bot.emit
  const events = []
  const settings = parseSettings({ protect: { targets: ["Bot.emit"] } })
  const watch = installHookWatch()
  const monitor = new IntegrityMonitor(settings, { Bot: bot }, event => events.push(event), watch)
  let received
  let calls = 0
  bot.once("fixture", value => {
    received = value
  })
  try {
    monitor.capture()
    Reflect.set(Emitter.prototype, "emit", function (...args) {
      calls++
      return originalEmit.apply(this, args)
    })
    assert.equal(bot.emit("fixture", "business-value"), true)
    assert.equal(bot.emit("fixture"), false)
    assert.equal(calls, 2)
    assert.equal(received, "business-value")
    const changed = events.find(event => event.target === "Bot.emit")
    assert.equal(changed.operation, "protected-target-change")
    assert.equal(changed.action, "audit")
    assert.equal(changed.details.detection, "during-call")
    assert.equal(changed.details.blocked, false)
    assert.equal(EventEmitter.prototype.emit, originalEmit)
  } finally {
    monitor.stop()
    watch.close()
  }
})

test("immediate changes retain existing rule priority and host recovery authorization", () => {
  for (const [rules, expected] of [
    [[], "restart"],
    [
      [
        { id: "first", operation: "protected-target-change", action: "audit" },
        { id: "later", kind: "integrity", action: "restart" },
      ],
      "audit",
    ],
  ]) {
    const watch = installHookWatch()
    const original = () => 1
    const bot = { send: original }
    const settings = parseSettings({
      protect: { targets: ["Bot.send"], action: "restart" },
      rules,
    })
    const events = []
    const monitor = new IntegrityMonitor(settings, { Bot: bot }, event => events.push(event), watch)
    try {
      monitor.capture()
      Reflect.set(bot, "send", () => 2)
      const changed = events.at(-1)
      assert.equal(changed.operation, "protected-target-change")
      assert.equal(changed.details.detection, "during-call")
      assert.equal(changed.action, expected)
      assert.equal(authorizeHostEvent(settings, changed).action, expected)
      if (!rules.length) {
        Reflect.set(bot, "send", bot.send)
        const unchanged = events.at(-1)
        assert.equal(unchanged.operation, "protected-target-hook")
        assert.equal(unchanged.action, "audit")
        assert.equal(authorizeHostEvent(settings, unchanged).action, "audit")
      }
    } finally {
      monitor.stop()
      watch.close()
    }
  }
})

test("transient explicit hooks and restoration are audited without changing descriptors", () => {
  const watch = installHookWatch()
  const original = function () {
    return this.value
  }
  const bot = { value: 7, send: original }
  const property = Object.getOwnPropertyDescriptor(bot, "send")
  const events = []
  const monitor = new IntegrityMonitor(
    parseSettings({ protect: { targets: ["Bot.send"] } }),
    { Bot: bot },
    event => events.push(event),
    watch,
  )
  try {
    monitor.capture()
    assert.deepEqual(Object.getOwnPropertyDescriptor(bot, "send"), property)
    const replacement = () => 9
    assert.equal(Object.defineProperty(bot, "send", { value: replacement }), bot)
    assert.equal(bot.send(), 9)
    assert.equal(Reflect.set(bot, "send", original), true)
    assert.equal(bot.send(), 7)
    monitor.check()
    assert.deepEqual(
      events.map(event => [event.operation, event.details.method, event.action]),
      [
        ["protected-target-change", "Object.defineProperty", "audit"],
        ["protected-target-change", "Reflect.set", "audit"],
      ],
    )
    bot.send = replacement
    monitor.check()
    assert.equal(events.at(-1).operation, "protected-target-change")
  } finally {
    monitor.stop()
    watch.close()
  }
})

test("observation preserves errors, rejected writes, getter calls and key coercion", () => {
  const watch = installHookWatch()
  const failure = new Error("original setter")
  const target = Object.defineProperties(
    {},
    {
      fixed: { value: 1 },
      setter: {
        set() {
          throw failure
        },
        configurable: true,
      },
    },
  )
  let coerced = 0
  let reads = 0
  const key = {
    [Symbol.toPrimitive]() {
      coerced++
      return "new"
    },
  }
  const events = []
  watch.track(target, {
    after(event) {
      events.push(event)
      throw new Error("observer failure")
    },
  })
  try {
    assert.equal(Reflect.set(target, "fixed", 2), false)
    assert.throws(
      () => Reflect.set(target, "setter", 2),
      error => error === failure,
    )
    Object.defineProperty(target, key, {
      get() {
        reads++
        return 7
      },
      configurable: true,
    })
    assert.equal(coerced, 1)
    assert.equal(reads, 0)
    assert.equal(target.new, 7)
    assert.equal(reads, 1)
    assert.deepEqual(
      events.map(event => event.outcome),
      ["rejected", "threw", "returned"],
    )
  } finally {
    watch.close()
  }
})

test("symbol, bulk, receiver and prototype operations preserve native behavior", () => {
  const watch = installHookWatch()
  const symbol = Symbol("method")
  const target = {}
  const receiver = {}
  const events = []
  watch.track(target, { after: event => events.push(event) })
  watch.track(receiver, { after: event => events.push(event) })
  try {
    Object.defineProperties(target, { run: { value: () => 1, configurable: true, writable: true } })
    Reflect.set(target, symbol, () => 2, receiver)
    assert.equal(receiver[symbol](), 2)
    assert.equal(Object.hasOwn(target, symbol), false)
    Reflect.deleteProperty(target, "run")
    Object.setPrototypeOf(target, null)
    Object.prototype.__defineGetter__.call(target, "getter", () => 3)
    assert.equal(target.getter, 3)
    assert.equal(Reflect.preventExtensions(target), true)
    assert.equal(events.filter(event => event.operation === "Reflect.set").length, 2)
    assert.equal(events.at(-1).changed, true)
    assert.equal(Object.getPrototypeOf(target), null)
  } finally {
    watch.close()
  }
})

test("trusted before rejection is enforced while audit callbacks cannot recurse", () => {
  const watch = installHookWatch()
  const denied = new Error("protected target")
  const target = { run: () => 1 }
  const events = []
  let nested = 0
  watch.track(target, {
    before() {
      throw denied
    },
    after(event) {
      events.push(event)
    },
  })
  const observed = {}
  watch.track(observed, {
    after() {
      nested++
      Reflect.set(observed, "nested", true)
    },
  })
  try {
    assert.throws(
      () => Object.assign(target, { run: () => 9 }),
      error => error === denied,
    )
    assert.equal(target.run(), 1)
    assert.equal(events[0].outcome, "blocked")
    Reflect.set(observed, "value", 7)
    assert.equal(nested, 1)
    assert.deepEqual(observed, { value: 7, nested: true })
  } finally {
    watch.close()
  }
})

test("Proxy observation does not add traps and closing preserves later wrappers", () => {
  const watch = installHookWatch()
  const calls = []
  const proxy = new Proxy(
    {},
    {
      defineProperty(target, key, property) {
        calls.push("define")
        return Reflect.defineProperty(target, key, property)
      },
      ownKeys() {
        throw new Error("unexpected enumeration")
      },
      getPrototypeOf() {
        throw new Error("unexpected prototype lookup")
      },
    },
  )
  watch.track(proxy, { after: event => calls.push(event.changed) })
  const wrapped = Object.defineProperty
  const replacement = new Proxy(wrapped, {})
  try {
    Object.defineProperty(proxy, "method", { value: () => 1 })
    assert.deepEqual(calls, ["define", undefined])
    Object.defineProperty = replacement
    watch.close()
    assert.equal(Object.defineProperty, replacement)
  } finally {
    Object.defineProperty = wrapped
    watch.close()
    // 此用例主动替换了全局入口，单独还原已关闭包装器的原值。
    Object.defineProperty = originalDefine
  }
})
