import assert from "node:assert/strict"
import { test } from "node:test"
import { RuntimeBus } from "../dist/runtime/bus.js"
import { createControlVerifier } from "../dist/runtime/control.js"

const controlKey = "a1".repeat(32)

function fixture(overrides = {}) {
  const writes = [],
    offers = [],
    callbacks = []
  let failures = 0
  const bus = new RuntimeBus({
    generation: 4,
    pid: 123,
    controlKey,
    connected: () => true,
    offer: (event, critical) => offers.push({ event, critical }),
    write(message, done) {
      writes.push(message)
      callbacks.push(done)
    },
    fail: () => failures++,
    ...overrides,
  })
  return { bus, writes, offers, callbacks, failures: () => failures }
}

test("runtime bus keeps audit admission independent of control transport", () => {
  const f = fixture({ connected: () => false })
  for (const action of ["audit", "deny", "restart"])
    f.bus.audit({ kind: "exec", operation: "spawn", target: "node", action })
  const legacy = { kind: "runtime", operation: "legacy", target: "test", action: "audit" }
  f.bus.send("violation", { event: legacy })
  assert.deepEqual(
    f.offers.map(row => row.critical),
    [false, true, true, true],
  )
  assert.equal(f.offers.at(-1).event, legacy)
  assert.equal(f.failures(), 0)
  assert.equal(f.writes.length, 0)
})

test("runtime bus deduplicates pending controls and releases them on real callbacks", () => {
  const f = fixture()
  f.bus.command({ type: "restart-request" })
  f.bus.command({ type: "restart-request" })
  f.bus.notify({ type: "worker-online" })
  assert.deepEqual(
    f.writes.map(row => row.type),
    ["restart-request", "worker-online"],
  )
  f.callbacks[0](null)
  f.bus.command({ type: "restart-request" })
  assert.equal(f.writes.length, 3)
  f.callbacks[2](new Error("closed IPC"))
  assert.equal(f.failures(), 1)
  const verify = createControlVerifier(controlKey, 4, 123)
  assert.equal(f.writes.every(verify), true)
})

test("runtime bus only exposes telemetry through the public context", () => {
  const f = fixture()
  const send = f.bus.send
  for (const type of [
    "restart-request",
    "stop-request",
    "preload-ready",
    "worker-online",
    "monitor-report",
    "custom-legacy-notice",
  ])
    assert.throws(() => send(type, { type: "spoof", generation: 999, pid: 999 }), {
      code: "ERR_GUARD_SELF_PROTECTION",
    })
  assert.equal(f.writes.length, 0)
  assert.equal(Object.isFrozen(f.bus), true)
  const other = fixture()
  other.bus.notify({ type: "worker-online", generation: 999, pid: 999, signature: "spoof" })
  assert.equal(other.writes.length, 1)
  assert.equal(createControlVerifier(controlKey, 4, 123)(other.writes[0]), true)
  assert.equal(Object.getPrototypeOf(other.writes[0]), null)
})

test("runtime bus keeps monitor reports separate from authenticated controls", () => {
  const f = fixture()
  const report = { status: "observing" }
  f.bus.notify({ type: "monitor-report", report })
  assert.equal(f.writes[0].report, report)
  assert.equal(f.writes[0].signature, undefined)
  assert.equal(createControlVerifier(controlKey, 4, 123)(f.writes[0]), false)
})

test("runtime bus fails closed on unavailable control delivery without retaining a failed request", () => {
  const disconnected = fixture({ connected: () => false })
  disconnected.bus.command({ type: "stop-request" })
  assert.equal(disconnected.failures(), 1)
  assert.equal(disconnected.writes.length, 0)
  let attempts = 0
  const throwing = fixture({
    write() {
      attempts++
      throw new Error("IPC failed")
    },
  })
  throwing.bus.command({ type: "stop-request" })
  throwing.bus.command({ type: "stop-request" })
  assert.equal(attempts, 2)
  assert.equal(throwing.failures(), 2)
})

test("runtime bus coalesces in-flight notices to the latest report", () => {
  const f = fixture()
  f.bus.notify({ type: "monitor-report", report: { n: 1 } })
  f.bus.notify({ type: "monitor-report", report: { n: 2 } })
  f.bus.notify({ type: "monitor-report", report: { n: 3 } })
  assert.equal(f.writes.length, 1)
  f.callbacks[0](null)
  assert.deepEqual(
    f.writes.map(row => row.report.n),
    [1, 3],
  )
  f.callbacks[1](null)
  assert.equal(f.writes.length, 2)
  assert.equal(f.failures(), 0)
})
