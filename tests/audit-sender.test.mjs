import assert from "node:assert/strict"
import test from "node:test"
import { auditModule, channelNonce, closeNonce, event } from "./audit-core-fixture.mjs"

const { AuditSender } = await auditModule("audit/sender")
const { createAuditDeadline, parseAuditFrame, stringifyAuditData } =
  await auditModule("audit/protocol")

test("ordinary retained count includes in-flight callbacks and deny cannot consume the restart lane", () => {
  const sent = [],
    callbacks = []
  const sender = new AuditSender({
    generation: 1,
    maxQueue: 2,
    channelNonce,
    completion: "callback",
    isConnected: () => true,
    write(frame, callback) {
      sent.push(frame)
      callbacks.push(callback)
    },
  })
  assert.equal(sender.offer(event()).accepted, true)
  assert.equal(sender.offer(event()).accepted, true)
  assert.equal(sender.offer(event()).reason, "queue-records")
  assert.equal(sender.offer(event("deny"), true).accepted, true)
  assert.equal(sender.offer(event("restart"), true).accepted, true)
  assert.equal(sender.offer(event("restart"), true).reason, "critical-coalesced")
  assert.equal(sent.filter(frame => frame.type === "violation").length, 1)
  assert.equal(sender.counters().pendingRecords, 4)
  callbacks.forEach(callback => callback())
  assert.equal(sender.counters().pendingRecords, 0)
  assert.equal(sender.counters().criticalCoalesced, 1)
  sender.dispose()
})

test("audit queue and ACK validation survive business builtin hooks without freezing their prototypes", () => {
  const define = Object.defineProperty,
    descriptor = Object.getOwnPropertyDescriptor
  const sent = [],
    hooks = [],
    results = {}
  const sender = new AuditSender({
    generation: 1,
    maxQueue: 3,
    completion: "hop",
    isConnected: () => true,
    write(frame, done) {
      sent[sent.length] = stringifyAuditData(frame)
      done()
    },
  })
  const ack = {
    auditProtocol: 1,
    generation: 1,
    channelNonce,
    type: "audit-hop-ack",
    auditSeq: 1,
    result: "received",
  }
  let calls = 0
  const poison = () => {
    calls++
    throw new Error("business builtin hook executed")
  }
  for (const [owner, keys] of [
    [
      Array.prototype,
      ["push", "shift", "find", "map", "filter", "some", "every", "includes", Symbol.iterator],
    ],
    [Map.prototype, ["get", "set", "has", "delete", "values", Symbol.iterator]],
    [Set.prototype, ["add", "has", "delete"]],
    [Object, ["defineProperty", "getOwnPropertyDescriptors", "getPrototypeOf", "entries", "keys"]],
    [JSON, ["stringify", "parse"]],
    [Array, ["isArray"]],
    [Number, ["isFinite", "isSafeInteger"]],
    [RegExp.prototype, ["exec", "test"]],
  ])
    for (const key of keys)
      hooks.push({ owner, key, before: descriptor(owner, key), value: poison })
  for (const [key, value] of Object.entries({ ...ack, toJSON: poison }))
    hooks.push({ owner: Object.prototype, key, before: descriptor(Object.prototype, key), value })
  try {
    for (let index = 0; index < hooks.length; index++) {
      const hook = hooks[index]
      define(hook.owner, hook.key, { value: hook.value, configurable: true, writable: true })
    }
    results.offer = sender.offer(event())
    results.bind = sender.bindChannel(channelNonce)
    results.invalid = parseAuditFrame({ ...ack, command: "stop" })
    results.inherited = parseAuditFrame({})
    results.wrong = sender.ack({ ...ack, channelNonce: closeNonce })
    results.ack = sender.ack(parseAuditFrame(ack))
    results.second = sender.offer(event("deny"), true)
    results.counters = sender.counters()
    sender.dispose()
    results.disposed = sender.counters()
  } finally {
    for (let index = hooks.length - 1; index >= 0; index--) {
      const hook = hooks[index]
      if (hook.before) define(hook.owner, hook.key, hook.before)
      else delete hook.owner[hook.key]
    }
  }
  assert.equal(calls, 0)
  assert.equal(results.offer.accepted, true)
  assert.equal(results.bind, true)
  assert.equal(results.invalid, undefined)
  assert.equal(results.inherited, undefined)
  assert.equal(results.wrong, false)
  assert.equal(results.ack, true)
  assert.equal(results.second.accepted, true)
  assert.equal(results.counters.hopReceived, 1)
  assert.equal(results.counters.sendCompleted, 2)
  assert.equal(results.disposed.pendingRecords, 0)
  assert.equal(results.disposed.rejected.disconnected, 1)
  assert.equal(JSON.parse(sent[0]).event.operation, "exec")
  assert.equal(JSON.parse(sent[1]).event.action, "deny")
})

test("critical priority allocates sequence in actual transport order and respects drain", () => {
  const sent = [],
    callbacks = []
  let writable = false
  const sender = new AuditSender({
    generation: 1,
    maxQueue: 2,
    channelNonce,
    completion: "callback",
    isConnected: () => true,
    write(frame, callback) {
      sent.push(frame)
      callbacks.push(callback)
      return writable
    },
  })
  sender.offer(event("audit", "first"))
  sender.offer(event("audit", "last"))
  sender.offer(event("deny", "deny"), true)
  sender.offer(event("restart", "restart"), true)
  assert.equal(sent.length, 1)
  writable = true
  sender.resume()
  assert.deepEqual(
    sent.map(frame => frame.event.target),
    ["first", "restart", "deny", "last"],
  )
  assert.deepEqual(
    sent.map(frame => frame.auditSeq),
    [1, 2, 3, 4],
  )
  callbacks.forEach(callback => callback())
  sender.dispose()
})

test("hop ACK binds generation/channel/sequence and callback completion stays separately counted", () => {
  let callback, frame
  const sender = new AuditSender({
    generation: 1,
    maxQueue: 1,
    channelNonce,
    completion: "hop",
    isConnected: () => true,
    write(value, done) {
      frame = value
      callback = done
    },
  })
  sender.offer(event())
  const ack = {
    auditProtocol: 1,
    generation: 1,
    channelNonce,
    type: "audit-hop-ack",
    auditSeq: frame.auditSeq,
    result: "received",
  }
  assert.equal(sender.ack({ ...ack, channelNonce: "c".repeat(48) }), false)
  assert.equal(sender.ack({ ...ack, generation: 2 }), false)
  assert.equal(sender.ack({ ...ack, auditSeq: 2 }), false)
  assert.equal(sender.ack(ack), true)
  assert.equal(sender.counters().hopReceived, 1)
  assert.equal(sender.counters().sendCompleted, 0)
  callback()
  callback()
  assert.equal(sender.counters().sendCompleted, 1)
  assert.equal(sender.ack(ack), false)
  assert.equal(sender.counters().pendingRecords, 0)
  sender.dispose()
})

test("unbound sender retains a bounded copy and cannot silently change its channel", () => {
  const sent = []
  const sender = new AuditSender({
    generation: 1,
    maxQueue: 3,
    completion: "callback",
    isConnected: () => true,
    write(frame, callback) {
      sent.push(frame)
      callback()
    },
  })
  const input = event("audit", "original")
  sender.offer(input)
  input.target = "mutated"
  assert.equal(sent.length, 0)
  assert.equal(sender.bindChannel(channelNonce), true)
  assert.equal(sent[0].event.target, "original")
  assert.equal(sender.bindChannel("c".repeat(48)), false)
  assert.equal(sender.offer({ value: 1n }).reason, "serialization")
  sender.dispose()
})

test("sealNow discloses unsent and unconfirmed tails and rejects all post-seal observations", () => {
  const callbacks = []
  const sender = new AuditSender({
    generation: 1,
    maxQueue: 2,
    channelNonce,
    completion: "callback",
    isConnected: () => true,
    write(frame, callback) {
      callbacks.push(callback)
      return false
    },
  })
  sender.offer(event())
  sender.offer(event())
  const seal = sender.sealNow({ nonce: closeNonce })
  assert.equal(seal.lastSentSeq, 1)
  assert.equal(seal.sourceCounters.accepted, 2)
  assert.equal(seal.sourceCounters.unknown, 1)
  assert.equal(seal.sourceCounters.rejected.deadline, 2)
  assert.equal(seal.sourceCounters.pendingRecords, 0)
  assert.equal(parseAuditFrame(seal).type, "audit-seal")
  callbacks[0]()
  assert.equal(sender.counters().sendCompleted, 1)
  assert.equal(seal.sourceCounters.sendCompleted, 0, "The closed snapshot must not change later")
  assert.equal(sender.offer(event("restart"), true).reason, "after-seal")
  assert.throws(() => sender.sealNow({ nonce: "c".repeat(48) }), /审计封存随机数已变化/)
  sender.dispose()
})

test("asynchronous seal uses one original deadline and reports error/disconnection instead of success", async () => {
  const sender = new AuditSender({
    generation: 1,
    maxQueue: 3,
    channelNonce,
    completion: "callback",
    isConnected: () => true,
    write() {},
  })
  sender.offer(event())
  const deadline = createAuditDeadline(20)
  const seal = await sender.seal({ nonce: closeNonce, deadline, nestedCoverage: "incomplete" })
  assert.equal(seal.sourceCounters.unknown, 1)
  assert.equal(seal.nestedCoverage, "incomplete")
  const original = await sender.seal({ nonce: closeNonce, deadline: createAuditDeadline(1000) })
  assert.equal(original, seal)
  sender.dispose()
  const disconnected = new AuditSender({
    generation: 1,
    maxQueue: 1,
    channelNonce,
    completion: "callback",
    isConnected: () => false,
    write() {
      throw new Error("Must not send")
    },
  })
  assert.equal(disconnected.offer(event()).reason, "disconnected")
  disconnected.dispose()
})

test("byte overflow and synchronous send failures are bounded and visible", () => {
  const sender = new AuditSender({
    generation: 1,
    maxQueue: 100,
    maxBytes: 1,
    channelNonce,
    completion: "callback",
    isConnected: () => true,
    write() {},
  })
  assert.equal(sender.offer(event()).reason, "queue-bytes")
  sender.dispose()
  const broken = new AuditSender({
    generation: 1,
    maxQueue: 1,
    channelNonce,
    completion: "callback",
    isConnected: () => true,
    write() {
      throw new Error("Transport failed")
    },
  })
  broken.offer(event())
  assert.equal(broken.counters().rejected["send-error"], 1)
  assert.equal(broken.counters().unknown, 1)
  assert.equal(broken.counters().pendingRecords, 0)
  broken.dispose()
})

test("send errors, rejected hop frames and connection getter failure never masquerade as Host writes", () => {
  let callback
  const sender = new AuditSender({
    generation: 1,
    maxQueue: 1,
    channelNonce,
    completion: "hop",
    isConnected: () => true,
    write(frame, done) {
      callback = done
    },
  })
  sender.offer(event())
  assert.equal(
    sender.ack({
      auditProtocol: 1,
      generation: 1,
      channelNonce,
      type: "audit-hop-ack",
      auditSeq: 1,
      result: "rejected-frame",
    }),
    true,
  )
  callback(new Error("late error"))
  assert.equal(sender.counters().rejected["rejected-frame"], 1)
  assert.equal(sender.counters().rejected["send-error"], 1)
  assert.equal(sender.counters().hopReceived, 0)
  sender.dispose()
  const disconnected = new AuditSender({
    generation: 1,
    maxQueue: 1,
    channelNonce,
    completion: "callback",
    isConnected() {
      throw new Error("getter")
    },
    write() {},
  })
  assert.equal(disconnected.offer(event()).reason, "disconnected")
  disconnected.dispose()
})

test("consecutive denials are all queued while repeated restarts still coalesce", () => {
  const sent = [],
    callbacks = []
  const sender = new AuditSender({
    generation: 1,
    maxQueue: 10,
    channelNonce,
    completion: "callback",
    isConnected: () => true,
    write(frame, callback) {
      sent.push(frame)
      callbacks.push(callback)
    },
  })
  for (let index = 0; index < 3; index++)
    assert.equal(sender.offer(event("deny"), true).accepted, true)
  assert.equal(sender.offer(event("restart"), true).accepted, true)
  assert.equal(sender.offer(event("restart"), true).reason, "critical-coalesced")
  assert.equal(sender.counters().pendingRecords, 4)
  callbacks.forEach(callback => callback())
  assert.equal(sender.counters().criticalCoalesced, 1)
  sender.dispose()
})
