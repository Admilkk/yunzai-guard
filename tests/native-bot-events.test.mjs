import assert from "node:assert/strict"
import test from "node:test"
import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"
import path from "node:path"

// 允许指定独立构建目录进行组件验证。
const moduleRoot = process.env.GUARD_BOT_EVENTS_MODULE_ROOT
  ? pathToFileURL(`${path.resolve(process.env.GUARD_BOT_EVENTS_MODULE_ROOT)}${path.sep}`)
  : new URL("../dist/native-sandbox/", import.meta.url)
const { NativeBotEventsHost } = await import(new URL("bot-events/host.js", moduleRoot))
const { NativeBotEventsGuest } = await import(new URL("bot-events/guest.js", moduleRoot))
const { parseBotEventFrame, parseBotEventArguments, botEventHandle, nativeBotEventLimits } =
  await import(new URL("bot-events/protocol.js", moduleRoot))

const tick = () => new Promise(resolve => setImmediate(resolve))
const clone = value => JSON.parse(JSON.stringify(value))
function emitterInterfaces(bot, overrides = {}) {
  return {
    key: bot,
    on: bot.on.bind(bot),
    off: bot.off.bind(bot),
    eventNames: bot.eventNames.bind(bot),
    listeners: bot.listeners.bind(bot),
    ...overrides,
  }
}
function fixture(t, bot = new EventEmitter(), options = {}) {
  bot.setMaxListeners(0)
  const frames = [],
    failures = [],
    invocations = [],
    policies = []
  let guest
  const host = new NativeBotEventsHost({
    emitter: emitterInterfaces(bot, options.emitter),
    policy: event => {
      policies.push(event)
      return options.policy?.(event)
    },
    invoke: async (id, args, event) => {
      invocations.push({ id, args, event })
      if (options.invoke) return options.invoke(id, args, event)
      return guest.dispatch(id, clone(args))
    },
    onFailure: failure => {
      failures.push(failure)
      options.onFailure?.(failure)
    },
    ...(options.serializeArgs ? { serializeArgs: options.serializeArgs } : {}),
  })
  guest = new NativeBotEventsGuest(
    frame => {
      frames.push(clone(frame))
      if (options.send) options.send(clone(frame), host)
      else host.receive(clone(frame))
    },
    { sessionId: host.sessionId, ...options.guest },
  )
  const facade = {}
  for (const name of ["on", "once", "off", "removeListener", "removeAllListeners"])
    facade[name] = (...args) => {
      guest[name](...args)
      return facade
    }
  guest.bindThis(facade)
  t.after(() => host.close())
  return { bot, host, guest, Bot: facade, frames, failures, invocations, policies }
}

test("sessions subscribe to the same core event without sharing callback or removal authority", async t => {
  const bot = new EventEmitter(),
    one = fixture(t, bot),
    two = fixture(t, bot)
  const seen = [],
    core = value => seen.push(["core", value.count])
  bot.on("message", core)
  const first = function (value) {
    assert.equal(this, one.Bot)
    seen.push(["one", value.count])
  }
  one.Bot.on("message", first)
  two.Bot.on("message", value => seen.push(["two", value.count]))
  assert.equal(
    one.Bot.on("extra", () => {}),
    one.Bot,
  )
  assert.notEqual(bot.listeners("message")[1], first)
  assert.doesNotMatch(JSON.stringify(one.frames), /callback|function/)
  bot.emit("message", { count: 1 })
  await tick()
  assert.deepEqual(seen, [
    ["core", 1],
    ["one", 1],
    ["two", 1],
  ])
  one.Bot.removeAllListeners("message")
  assert.equal(bot.listenerCount("message"), 2)
  assert.equal(bot.listeners("message")[0], core)
  one.host.close()
  bot.emit("message", { count: 2 })
  await tick()
  assert.deepEqual(seen.slice(-2), [
    ["core", 2],
    ["two", 2],
  ])
  assert.equal(two.host.stats.listeners, 1)
})

test("off removes the last duplicate callback and removeAllListeners stays session-local", async t => {
  const f = fixture(t),
    order = []
  const callback = () => order.push("duplicate")
  f.Bot.on("message", callback)
    .on("message", () => order.push("middle"))
    .once("message", callback)
  f.Bot.off("message", callback)
  assert.equal(f.frames.at(-1).id, f.frames[2].id)
  f.bot.emit("message")
  await tick()
  assert.deepEqual(order, ["duplicate", "middle"])
  const before = f.frames.length
  f.Bot.off("message", () => {})
  assert.equal(f.frames.length, before, "An unknown local callback is the usual no-op")
  f.Bot.removeListener("message", callback)
  assert.equal(f.host.stats.listeners, 1)
  f.Bot.on("other", callback).removeAllListeners()
  assert.equal(f.host.stats.listeners, 0)
  assert.equal(f.guest.size, 0)
})

test("once leaves the host ledger before delivery and rejects a repeated guest invocation", async t => {
  const f = fixture(t),
    calls = []
  f.Bot.once("connect.123", async value => {
    assert.equal(f.host.stats.listeners, 0)
    assert.equal(f.guest.size, 0)
    calls.push(value)
    f.bot.emit("connect.123", "reentrant")
    await tick()
  })
  const id = f.frames[0].id
  f.bot.emit("connect.123", "original")
  f.bot.emit("connect.123", "duplicate")
  assert.equal(f.host.stats.listeners, 0)
  assert.equal(f.bot.listenerCount("connect.123"), 0)
  await tick()
  await tick()
  assert.deepEqual(calls, ["original"])
  await assert.rejects(f.guest.dispatch(id, ["replay"]), { code: "BOT_EVENT_UNKNOWN_HANDLE" })
  assert.equal(f.failures.length, 0)
})

test("off/clear cancels a queued once delivery without treating it as a foreign capability", async t => {
  for (const clear of [false, true]) {
    const f = fixture(t),
      seen = [],
      callback = () => seen.push(true)
    f.Bot.once("message", callback)
    f.bot.emit("message", "pending")
    if (clear) f.Bot.removeAllListeners()
    else f.Bot.off("message", callback)
    await tick()
    assert.deepEqual(seen, [])
    assert.equal(f.failures.length, 0)
    assert.equal(f.host.stats.listeners, 0)
  }
})

test("callback throws/rejections, bad payloads and failure reporting never throw through core emit", async t => {
  const f = fixture(t, undefined, {
    onFailure: () => {
      throw new Error("logger failed")
    },
  })
  let coreCalls = 0
  f.bot.on("message", () => coreCalls++)
  f.Bot.on("message", () => {
    throw new Error("guest callback failed")
  })
  f.Bot.on("message", async () => {
    throw new Error("guest callback rejected")
  })
  assert.doesNotThrow(() => f.bot.emit("message", { value: "safe" }))
  await tick()
  assert.equal(coreCalls, 1)
  assert.equal(f.failures.length, 2)
  assert.ok(f.failures.every(value => value.kind === "delivery"))
  const event = {
    reply() {
      throw new Error("A live core function must not cross IPC")
    },
  }
  assert.doesNotThrow(() => f.bot.emit("message", event))
  await tick()
  assert.equal(f.failures.length, 4)
  assert.equal(f.invocations.length, 2, "No live function payload was delivered")
})

test("trusted event projection sends a DTO and keeps original reply authority host-local", async t => {
  const event = { user_id: "123", reply: async () => "host-only" }
  let received, bound
  const f = fixture(t, undefined, {
    serializeArgs: args => [{ user_id: args[0].user_id, replyAvailable: true }],
    guest: {
      restoreArgs: args => args.map(value => ({ ...value, reply: async () => "guest-local-rpc" })),
    },
    invoke: async (id, args, originalEvent) => {
      bound = originalEvent
      return f.guest.dispatch(id, clone(args))
    },
  })
  f.Bot.on("message.private", async value => {
    received = await value.reply()
  })
  f.bot.emit("message.private", event)
  await tick()
  assert.equal(received, "guest-local-rpc")
  assert.equal(bound, event)
  assert.equal(f.invocations[0].args[0].reply, undefined)
  assert.notEqual(f.invocations[0].args[0], event)
})

test("host independently enforces session quota, emitter-wide quota including core and quota release", t => {
  const bot = new EventEmitter(),
    sessions = []
  bot.setMaxListeners(0)
  const core = () => {}
  bot.on("core", core)
  for (let index = 0; index < 8; index++) {
    const f = fixture(t, bot)
    sessions.push(f)
    const count = index === 7 ? 127 : nativeBotEventLimits.sessionListeners
    for (let listener = 0; listener < count; listener++) f.Bot.on("message", () => {})
  }
  assert.equal(bot.listenerCount("message") + bot.listenerCount("core"), 1024)
  const quota = sessions[0],
    sequence = quota.frames.length + 1
  assert.throws(
    () =>
      quota.host.receive({
        type: "subscribe",
        sessionId: quota.host.sessionId,
        sequence,
        id: botEventHandle(quota.host.sessionId, sequence),
        event: "other",
        once: false,
      }),
    { code: "BOT_EVENT_SESSION_LIMIT" },
  )
  const overflow = fixture(t, bot)
  assert.throws(() => overflow.Bot.on("other", () => {}), { code: "BOT_EVENT_EMITTER_LIMIT" })
  sessions[0].host.close()
  const replacement = fixture(t, bot)
  replacement.Bot.on("other", () => {})
  assert.equal(replacement.host.stats.listeners, 1)
  assert.equal(bot.listeners("core")[0], core)
})

test("guest quota is enforced before it publishes an excessive listener", t => {
  const f = fixture(t)
  for (let index = 0; index < 128; index++) f.Bot.on("event", () => {})
  assert.throws(() => f.Bot.once("event", () => {}), { code: "BOT_EVENT_SESSION_LIMIT" })
  assert.equal(f.frames.length, 128)
})

test("replayed, reordered, recycled and foreign handles/frames cannot change another session", async t => {
  const bot = new EventEmitter(),
    one = fixture(t, bot),
    two = fixture(t, bot)
  one.Bot.on("event", () => {})
  two.Bot.on("event", () => {})
  const first = one.frames[0]
  assert.throws(() => one.host.receive(first), { code: "BOT_EVENT_REPLAY" })
  assert.throws(() => two.host.receive(first), { code: "BOT_EVENT_FOREIGN_SESSION" })
  assert.throws(
    () =>
      two.host.receive({
        type: "unsubscribe",
        sessionId: two.host.sessionId,
        sequence: 2,
        id: first.id,
      }),
    { code: "BOT_EVENT_FOREIGN_HANDLE" },
  )
  await assert.rejects(two.guest.dispatch(first.id, []), { code: "BOT_EVENT_FOREIGN_HANDLE" })
  assert.throws(
    () =>
      one.host.receive({
        type: "unsubscribe",
        sessionId: one.host.sessionId,
        sequence: 4,
        id: first.id,
      }),
    { code: "BOT_EVENT_REPLAY" },
  )
  one.Bot.removeAllListeners()
  assert.throws(() => one.host.receive({ ...first, sequence: 3 }), {
    code: "BOT_EVENT_INVALID_FRAME",
  })
  assert.throws(
    () =>
      one.host.receive({
        type: "unsubscribe",
        sessionId: one.host.sessionId,
        sequence: 3,
        id: first.id,
      }),
    { code: "BOT_EVENT_UNKNOWN_HANDLE" },
  )
  assert.equal(two.host.stats.listeners, 1)
  assert.equal(bot.listenerCount("event"), 1)
})

test("event policy authorizes registration only; denied callbacks never attach", t => {
  const f = fixture(t, undefined, { policy: event => event !== "denied" })
  f.Bot.on("allowed", () => {})
  f.Bot.off("allowed", () => {}).removeAllListeners()
  assert.deepEqual(f.policies, ["allowed"])
  assert.throws(() => f.Bot.on("denied", () => {}), { code: "BOT_EVENT_POLICY_DENIED" })
  assert.equal(f.bot.listenerCount("denied"), 0)
  assert.equal(f.host.stats.listeners, 0)
})

test("failed removal retains ownership, disables callbacks, reports failure and permits retry", async t => {
  const bot = new EventEmitter(),
    peer = () => {},
    core = () => {}
  bot.on("event", core)
  const other = fixture(t, bot)
  other.Bot.on("event", peer)
  let fail = true,
    calls = 0
  const f = fixture(t, bot, {
    emitter: {
      off: (name, listener) => {
        if (!fail) bot.off(name, listener)
      },
    },
  })
  f.Bot.on("event", () => calls++)
  assert.throws(() => f.host.close(), { code: "BOT_EVENT_CLEANUP_UNCONFIRMED" })
  assert.equal(f.host.stats.listeners, 1)
  assert.equal(bot.listenerCount("event"), 3)
  assert.equal(f.failures[0].kind, "cleanup")
  assert.throws(() => f.host.receive(f.frames[0]), { code: "BOT_EVENT_CLOSED" })
  assert.doesNotThrow(() => bot.emit("event"))
  await tick()
  assert.equal(calls, 0, "Retained wrappers are already revoked")
  fail = false
  assert.doesNotThrow(() => f.host.close())
  assert.equal(f.host.stats.listeners, 0)
  assert.equal(bot.listenerCount("event"), 2)
  assert.ok(bot.listeners("event").includes(core))
  assert.equal(other.host.stats.listeners, 1)
  assert.doesNotThrow(() => f.host.close())
})

test("registration rollback and reentrant close cannot leave an untracked host listener", t => {
  const bot = new EventEmitter()
  let host
  const failures = []
  host = new NativeBotEventsHost({
    emitter: emitterInterfaces(bot, {
      on(name, listener) {
        host.close()
        bot.on(name, listener)
      },
    }),
    policy: () => {},
    invoke: async () => {},
    onFailure: failure => failures.push(failure),
  })
  const sessionId = host.sessionId
  assert.throws(
    () =>
      host.receive({
        type: "subscribe",
        sessionId,
        sequence: 1,
        id: botEventHandle(sessionId, 1),
        event: "event",
        once: false,
      }),
    { code: "BOT_EVENT_CLEANUP_UNCONFIRMED" },
  )
  assert.equal(bot.listenerCount("event"), 0)
  assert.equal(host.stats.listeners, 0)
  assert.ok(failures.some(value => value.kind === "cleanup"))
  host.close()
})

test("once cleanup failure cannot run the callback or throw through the core emitter", async t => {
  let fail = true,
    calls = 0
  const bot = new EventEmitter()
  const f = fixture(t, bot, {
    emitter: {
      off(name, listener) {
        if (!fail) bot.off(name, listener)
      },
    },
  })
  f.Bot.once("event", () => calls++)
  assert.doesNotThrow(() => bot.emit("event"))
  assert.doesNotThrow(() => bot.emit("event"))
  await tick()
  assert.equal(calls, 0)
  assert.equal(f.host.stats.listeners, 1)
  assert.equal(f.failures.length, 1)
  assert.equal(f.failures[0].kind, "cleanup")
  fail = false
  f.host.close()
})

test("core-shaped rawListeners exit awaits real guest cleanup and catches its failure", async t => {
  const f = fixture(t),
    calls = []
  let finish
  const gate = new Promise(resolve => {
    finish = resolve
  })
  f.Bot.once("exit", async function (reason) {
    assert.equal(this, f.Bot)
    calls.push(["started", reason])
    await gate
    calls.push(["finished", reason])
  })
  f.Bot.on("exit", async () => {
    throw new Error("guest exit failure")
  })
  let settled = false
  // 采用 lib/bot.js 的 exitEvent 调用形态，保留其返回值语义。
  const exiting = Promise.all(
    f.bot
      .rawListeners("exit")
      .map(listener => Promise.resolve().then(() => listener.call(f.bot, "shutdown"))),
  ).then(() => {
    settled = true
  })
  await tick()
  assert.deepEqual(calls, [["started", "shutdown"]])
  assert.equal(settled, false)
  assert.equal(f.failures.length, 1)
  finish()
  await exiting
  await f.guest.dispatchExit(["local-shutdown"])
  assert.equal(settled, true)
  assert.deepEqual(calls, [
    ["started", "shutdown"],
    ["finished", "shutdown"],
  ])
  assert.equal(f.failures.length, 1, "The failed host-delivered exit callback was not run twice")
})

test("an emitter throw after attach is rolled back while rollback failure keeps its ledger", t => {
  for (const rollbackFails of [false, true]) {
    const bot = new EventEmitter()
    let broken = rollbackFails
    const failures = []
    const host = new NativeBotEventsHost({
      emitter: emitterInterfaces(bot, {
        on(name, listener) {
          bot.on(name, listener)
          throw new Error("attach failed after effect")
        },
        off(name, listener) {
          if (broken) throw new Error("rollback failed")
          bot.off(name, listener)
        },
      }),
      policy: () => {},
      invoke: async () => {},
      onFailure: failure => failures.push(failure),
    })
    const sessionId = host.sessionId
    assert.throws(
      () =>
        host.receive({
          type: "subscribe",
          sessionId,
          sequence: 1,
          id: botEventHandle(sessionId, 1),
          event: "event",
          once: false,
        }),
      rollbackFails ? { code: "BOT_EVENT_CLEANUP_UNCONFIRMED" } : /attach failed after effect/,
    )
    assert.equal(host.stats.listeners, rollbackFails ? 1 : 0)
    assert.equal(bot.listenerCount("event"), rollbackFails ? 1 : 0)
    assert.equal(failures.length, rollbackFails ? 1 : 0)
    broken = false
    host.close()
    assert.equal(bot.listenerCount("event"), 0)
    assert.equal(host.stats.listeners, 0)
  }
})

test("off throws or inspection fails after removal retain the ledger until a confirmed retry", t => {
  for (const mode of ["throw", "inspection"]) {
    const bot = new EventEmitter()
    let broken = false
    const f = fixture(t, bot, {
      emitter: {
        off(name, listener) {
          bot.off(name, listener)
          if (broken && mode === "throw") throw new Error("off failed after effect")
        },
        listeners(name) {
          if (broken && mode === "inspection") throw new Error("inspection unavailable")
          return bot.listeners(name)
        },
      },
    })
    f.Bot.on("event", () => {})
    broken = true
    assert.throws(() => f.host.close(), { code: "BOT_EVENT_CLEANUP_UNCONFIRMED" })
    assert.equal(f.host.stats.listeners, 1)
    assert.equal(bot.listenerCount("event"), 0)
    assert.equal(f.failures.length, 1)
    broken = false
    f.host.close()
    assert.equal(f.host.stats.listeners, 0)
  }
})

test("quota reserves pending on operations across reentrant sessions sharing one emitter", t => {
  const bot = new EventEmitter()
  bot.setMaxListeners(0)
  const nestedErrors = []
  let armed = false,
    nested
  // 真实 newListener 回调先于 EventEmitter 挂载新监听器执行。
  bot.on("newListener", () => {
    if (!armed) return
    armed = false
    const sessionId = nested.sessionId
    try {
      nested.receive({
        type: "subscribe",
        sessionId,
        sequence: 1,
        id: botEventHandle(sessionId, 1),
        event: "nested",
        once: false,
      })
    } catch (error) {
      nestedErrors.push(error)
    }
  })
  for (let index = 0; index < 1022; index++) bot.on("core", () => {})
  const f = fixture(t, bot)
  nested = new NativeBotEventsHost({
    emitter: emitterInterfaces(bot),
    policy: () => {},
    invoke: async () => {},
    onFailure: () => {},
  })
  armed = true
  f.Bot.on("outer", () => {})
  assert.equal(nestedErrors[0].code, "BOT_EVENT_EMITTER_LIMIT")
  assert.equal(bot.listenerCount("nested"), 0)
  assert.equal(f.host.stats.listeners, 1)
  nested.close()
})

test("bounded pending deliveries do not hold core emit open and close suppresses queued work", async t => {
  let finish
  const waiting = new Promise(resolve => {
    finish = resolve
  })
  const f = fixture(t, undefined, { invoke: () => waiting })
  f.Bot.on("event", () => {})
  for (let count = 0; count < 129; count++) assert.doesNotThrow(() => f.bot.emit("event", count))
  assert.equal(f.host.stats.pendingDeliveries, 128)
  assert.equal(f.failures[0].error.code, "BOT_EVENT_DELIVERY_LIMIT")
  f.host.close()
  await tick()
  assert.equal(f.invocations.length, 0)
  assert.equal(f.host.stats.pendingDeliveries, 0)
  finish()
})

test("local exit notifies old cleanup callbacks once and host/local crossing cannot duplicate them", async t => {
  const f = fixture(t),
    calls = []
  f.Bot.once("exit", async () => {
    calls.push("once")
    await tick()
  })
  f.Bot.on("exit", () => calls.push("on"))
  f.Bot.once("exit", () => {
    calls.push("failure")
    throw new Error("exit failed")
  })
  const ids = f.frames.map(frame => frame.id)
  await f.guest.dispatch(ids[0], [])
  await assert.rejects(f.guest.dispatchExit(), /插件进程的 Bot 退出监听执行失败/)
  await assert.rejects(f.guest.dispatchExit(), /插件进程的 Bot 退出监听执行失败/)
  await f.guest.dispatch(ids[0], [])
  await f.guest.dispatch(ids[1], [])
  assert.deepEqual(calls, ["once", "on", "failure"])
  assert.equal(f.frames.length, 3, "Local shutdown notification never emits a forged core event")
  f.guest.close()
  assert.equal(f.host.stats.listeners, 0)
  await assert.rejects(f.guest.dispatch(ids[1], []), { code: "BOT_EVENT_CLOSED" })
})

test("local exit snapshots callbacks before cleanup can remove siblings and ignores SDK returns", async t => {
  const f = fixture(t),
    calls = []
  f.Bot.on("exit", () => {
    calls.push("first")
    f.Bot.removeAllListeners("exit")
  })
  f.Bot.once("exit", () => calls.push("second"))
  await f.guest.dispatchExit()
  assert.deepEqual(calls, ["first", "second"])
  f.Bot.on("message", () => new EventEmitter())
  const id = f.frames.at(-1).id
  assert.equal(
    await f.guest.dispatch(id, []),
    undefined,
    "Live callback return values stay in the guest",
  )
})

test("local disposal awaits already-running host on/once exit cleanup, including reentry and rejection", async t => {
  for (const once of [false, true])
    for (const reject of [false, true]) {
      const f = fixture(t)
      let finish,
        started = false,
        finished = false,
        settled = false,
        calls = 0
      const gate = new Promise(resolve => {
        finish = resolve
      })
      f.Bot[once ? "once" : "on"]("exit", async () => {
        calls++
        started = true
        await f.guest.dispatchExit() // 重入通知不能等待当前回调自身完成。
        await gate
        finished = true
        if (reject) throw new Error("exit gate rejection")
      })
      const exiting = Promise.all(f.bot.rawListeners("exit").map(listener => listener("host-exit")))
      await tick()
      assert.equal(started, true)
      const disposal = f.guest.dispatchExit().finally(() => {
        settled = true
      })
      const observed = reject
        ? assert.rejects(disposal, /插件进程的 Bot 退出监听执行失败/)
        : disposal
      await tick()
      assert.equal(
        settled,
        false,
        "Removing/deduplicating an exit handle must not discard its pending work",
      )
      assert.equal(finished, false)
      finish()
      await observed
      await exiting
      assert.equal(calls, 1)
      assert.equal(finished, true)
      assert.equal(settled, true)
    }
})

test("once failures before or during invoke retain an exact late-off tombstone", async t => {
  for (const kind of ["dto", "invoke"]) {
    const f = fixture(
      t,
      undefined,
      kind === "invoke"
        ? {
            invoke: async () => {
              throw new Error("not delivered")
            },
          }
        : {},
    )
    const callback = () => {}
    f.Bot.once("failed-once", callback)
    f.bot.emit("failed-once", kind === "dto" ? { large: "x".repeat(65537) } : "safe")
    await tick()
    assert.equal(f.host.stats.listeners, 0)
    assert.equal(f.guest.size, 1)
    assert.equal(f.host.stats.retiredOnce, 1)
    assert.doesNotThrow(() => f.Bot.off("failed-once", callback))
    assert.equal(f.host.stats.retiredOnce, 0)
    assert.equal(f.guest.size, 0)
    const off = f.frames.at(-1)
    assert.throws(() => f.host.receive(off), { code: "BOT_EVENT_REPLAY" })
    assert.throws(() => f.host.receive({ ...off, sequence: off.sequence + 1 }), {
      code: "BOT_EVENT_UNKNOWN_HANDLE",
    })
  }
})

test("failed once history is bounded without eviction and off/clear release its reserved capacity", async () => {
  const bot = new EventEmitter(),
    failures = []
  const host = new NativeBotEventsHost({
    emitter: emitterInterfaces(bot),
    policy: () => {},
    invoke: async () => {
      throw new Error("invoke not confirmed")
    },
    onFailure: error => failures.push(error),
  })
  let sequence = 0
  const subscribe = () => {
    const id = botEventHandle(host.sessionId, ++sequence)
    host.receive({
      type: "subscribe",
      sessionId: host.sessionId,
      sequence,
      id,
      event: "once",
      once: true,
    })
    return id
  }
  let oldest
  for (let index = 0; index < nativeBotEventLimits.retiredOnce; index++) {
    const id = subscribe()
    oldest ??= id
    bot.emit("once")
    await tick()
  }
  assert.equal(host.stats.retiredOnce, nativeBotEventLimits.retiredOnce)
  assert.throws(subscribe, { code: "BOT_EVENT_RETIREMENT_LIMIT" })
  assert.equal(host.stats.retiredOnce, nativeBotEventLimits.retiredOnce)
  host.receive({ type: "unsubscribe", sessionId: host.sessionId, sequence: ++sequence, id: oldest })
  assert.equal(
    host.stats.retiredOnce,
    nativeBotEventLimits.retiredOnce - 1,
    "The oldest debt was not silently evicted",
  )
  subscribe()
  host.receive({ type: "clear", sessionId: host.sessionId, sequence: ++sequence, event: "once" })
  assert.equal(host.stats.retiredOnce, 0)
  assert.equal(host.stats.listeners, 0)
  assert.equal(failures.length, nativeBotEventLimits.retiredOnce)
  host.close()
})

test("protocol accepts bounded literal names and rejects getters, expressions as callbacks and non-DTO values", () => {
  const sessionId = randomUUID(),
    valid = {
      type: "subscribe",
      sessionId,
      sequence: 1,
      id: botEventHandle(sessionId, 1),
      event: "自定义:event.with-dots",
      once: false,
    }
  assert.deepEqual(parseBotEventFrame(valid), valid)
  for (const event of ["", "\0", "x\n", "x".repeat(257), Symbol("event"), {}, 12])
    assert.throws(() => parseBotEventFrame({ ...valid, event }), { code: "BOT_EVENT_INVALID_NAME" })
  let getterCalls = 0
  const getter = { ...valid }
  Object.defineProperty(getter, "event", {
    enumerable: true,
    get() {
      getterCalls++
      return "event"
    },
  })
  assert.throws(() => parseBotEventFrame(getter), { code: "BOT_EVENT_INVALID_FRAME" })
  assert.equal(getterCalls, 0)
  assert.throws(() => parseBotEventFrame({ ...valid, expression: "process.exit()" }), {
    code: "BOT_EVENT_INVALID_FRAME",
  })
  assert.throws(() => parseBotEventFrame({ ...valid, once: "true" }), {
    code: "BOT_EVENT_INVALID_FRAME",
  })
  assert.throws(() => parseBotEventArguments([new EventEmitter()]), {
    code: "BOT_EVENT_INVALID_DTO",
  })
  assert.throws(() => parseBotEventArguments([() => {}]), { code: "BOT_EVENT_INVALID_DTO" })
  assert.throws(() => parseBotEventArguments([Buffer.from("live")]), {
    code: "BOT_EVENT_INVALID_DTO",
  })
  assert.throws(() => parseBotEventArguments([Object.create(Array.prototype)]), {
    code: "BOT_EVENT_INVALID_DTO",
  })
  assert.throws(() => parseBotEventArguments(["中".repeat(24000)]), {
    code: "BOT_EVENT_FRAME_LIMIT",
  })
  assert.throws(() => parseBotEventArguments(Array(1)), { code: "BOT_EVENT_INVALID_DTO" })
  const value = { nested: [1, true, "value"] },
    dto = parseBotEventArguments([value])
  assert.notEqual(dto[0], value)
  assert.deepEqual(clone(dto), [value])
})
