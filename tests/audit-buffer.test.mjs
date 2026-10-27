import assert from "node:assert/strict"
import test from "node:test"
import { auditModule, clock, closeNonce } from "./audit-core-fixture.mjs"

const { AuditBuffer } = await auditModule("audit/buffer")
const { createAuditDeadline } = await auditModule("audit/protocol")
function setup(rate = 100, maxBytes = 10 * 1024 * 1024) {
  const timer = clock(),
    written = []
  let sequence = 0
  const sink = {
    appendBatch(frames) {
      written.push(...frames)
      return frames.map(() => ({ result: "written", sequence: ++sequence, bytes: 100 }))
    },
  }
  return {
    timer,
    written,
    buffer: new AuditBuffer({
      sink,
      maxEventsPerSecond: rate,
      maxBytes,
      now: timer.now,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    }),
  }
}

test("1665 observations survive a normal burst while monotonic steady rate remains 100/s", async () => {
  const { buffer, timer, written } = setup()
  for (let index = 0; index < 1665; index++)
    assert.equal(buffer.offer({ type: "audit", details: { index } }).accepted, true)
  timer.advance(0)
  assert.equal(written.length, 100)
  assert.equal(buffer.stats().ordinaryPending, 1565)
  timer.advance(1000)
  assert.equal(written.length, 200)
  const deadline = createAuditDeadline(2000)
  const permit = buffer.createClosePermit({ generation: 1, nonce: closeNonce, deadline })
  const summary = await buffer.close(permit)
  assert.equal(summary.outcome, "all-offered-written")
  assert.equal(written.length, 1665)
  assert.equal(buffer.stats().dropped, 0)
  assert.equal(timer.jobs(), 0)
})

test("explicit 1000/s remains a distinct steady rate rather than silently changing defaults", async () => {
  const { buffer, timer, written } = setup(1000)
  for (let index = 0; index < 1665; index++) buffer.offer({ type: "audit" })
  timer.advance(0)
  assert.equal(written.length, 1000)
  assert.equal(buffer.stats().ordinaryPending, 665)
  const deadline = createAuditDeadline(1000)
  await buffer.close(buffer.createClosePermit({ generation: 1, nonce: closeNonce, deadline }))
  assert.equal(written.length, 1665)
})

test("a blocking append finishing after the deadline does not become a timely flush success", async () => {
  const timer = clock()
  const buffer = new AuditBuffer({
    maxEventsPerSecond: 1,
    maxBytes: 4096,
    now: timer.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    sink: {
      appendBatch: frames => {
        timer.advance(10)
        return frames.map(() => ({ result: "written", sequence: 1, bytes: 1 }))
      },
    },
  })
  const receipts = []
  buffer.offer({ type: "audit" }, { onSettled: row => receipts.push(row) })
  const deadline = createAuditDeadline(5, timer.now)
  const summary = await buffer.close(
    buffer.createClosePermit({ generation: 1, nonce: closeNonce, deadline }),
  )
  assert.equal(receipts[0].result, "written", "The append itself is known complete")
  assert.equal(summary.deadlineExceeded, true)
  assert.equal(summary.outcome, "incomplete")
})

test("retained ordinary count includes in-flight entries and critical has its own finite evidence slot", async () => {
  const timer = clock(),
    receipts = []
  let buffer, injected
  const sink = {
    appendBatch(frames) {
      injected ??= buffer.offer({ type: "audit" })
      return frames.map((_, index) => ({ result: "written", sequence: index + 1, bytes: 20 }))
    },
  }
  buffer = new AuditBuffer({
    sink,
    maxEventsPerSecond: 1,
    maxBytes: 10 * 1024 * 1024,
    now: timer.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  })
  for (let index = 0; index < 4096; index++) buffer.offer({ type: "audit" })
  assert.equal(buffer.offer({ type: "audit" }).reason, "queue-records")
  assert.equal(
    buffer.offer(
      { type: "violation" },
      {
        critical: true,
        onSettled: value => receipts.push(value),
      },
    ).accepted,
    true,
  )
  assert.equal(
    buffer.offer(
      { type: "violation" },
      {
        critical: true,
        onSettled: value => receipts.push(value),
      },
    ).reason,
    "critical-coalesced",
  )
  timer.advance(0)
  assert.equal(injected.reason, "queue-records")
  assert.deepEqual(
    receipts.map(row => row.result),
    ["rejected", "written"],
  )
  assert.equal(buffer.stats().criticalPending, 0)
  assert.equal(buffer.stats().highWaterRecords, 4096)
  const deadline = createAuditDeadline(0)
  await buffer.close(buffer.createClosePermit({ generation: 1, nonce: closeNonce, deadline }))
})

test("byte bound uses min(2MiB,maxBytes) and immediate rejection settles exactly once", async () => {
  const { buffer } = setup(1, 1024)
  const receipts = []
  let result
  do {
    result = buffer.offer(
      { type: "audit", details: { text: "x".repeat(200) } },
      {
        onSettled: value => receipts.push(value),
      },
    )
  } while (result.accepted)
  assert.equal(result.reason, "queue-bytes")
  assert.equal(receipts.length, 1)
  assert.ok(buffer.stats().ordinaryPendingBytes <= 1024)
  assert.equal(
    buffer.offer({ type: "audit", details: { text: "x".repeat(2000) } }).reason,
    "oversize",
  )
  const deadline = createAuditDeadline(0)
  const before = buffer.stats().accepted
  await buffer.close(buffer.createClosePermit({ generation: 1, nonce: closeNonce, deadline }))
  assert.equal(receipts.length, before + 1)
})

test("one authenticated close cutoff accelerates a bounded tail and cannot be enlarged or replayed", async () => {
  const { buffer, timer, written } = setup(1)
  for (let index = 0; index < 200; index++) buffer.offer({ type: "audit" })
  const deadline = createAuditDeadline(1000)
  const permit = buffer.createClosePermit({ generation: 1, nonce: closeNonce, deadline })
  assert.equal(
    await buffer.flush({ deadline, closePermit: permit }).then(row => row.accelerated),
    true,
  )
  assert.equal(written.length, 200)
  buffer.offer({ type: "audit", details: { late: 1 } })
  timer.advance(0)
  assert.equal(written.length, 201, "Only the original steady token may write after cutoff")
  buffer.offer({ type: "audit", details: { late: 2 } })
  const repeat = await buffer.flush({ deadline, closePermit: permit })
  assert.equal(repeat.accelerated, false)
  assert.equal(buffer.stats().ordinaryPending, 1)
  assert.equal(
    buffer.createClosePermit({
      generation: 1,
      nonce: closeNonce,
      deadline: createAuditDeadline(100000),
    }),
    permit,
  )
  assert.throws(
    () => buffer.createClosePermit({ generation: 1, nonce: "c".repeat(48), deadline }),
    /审计关闭随机数已变化/,
  )
  await assert.rejects(
    buffer.flush({ deadline, closePermit: { ...permit } }),
    /审计关闭许可不属于本方或已过期/,
  )
  const final = buffer.createClosePermit({
    generation: 2,
    nonce: "d".repeat(48),
    deadline: createAuditDeadline(0),
  })
  await assert.rejects(buffer.close(permit), /审计关闭许可不属于本方或已过期/)
  assert.equal((await buffer.close(final)).outcome, "incomplete")
})

test("queued observations capture generation and wall time; later mutable inputs cannot relabel them", async () => {
  const { buffer, timer, written } = setup(1)
  const frame = { type: "audit", time: 100, details: { generation: 1, event: { target: "old" } } }
  buffer.offer(frame)
  frame.time = -100
  frame.details.generation = 2
  frame.details.event.target = "new"
  timer.advance(0)
  assert.equal(Object.getPrototypeOf(written[0].details), null)
  assert.equal(Object.getPrototypeOf(written[0].details.event), null)
  assert.deepEqual(JSON.parse(JSON.stringify(written[0])), {
    type: "audit",
    time: 100,
    details: { generation: 1, event: { target: "old" } },
  })
  const deadline = createAuditDeadline(0)
  await buffer.close(buffer.createClosePermit({ generation: 1, nonce: closeNonce, deadline }))
})

test("sink unknown and callback errors remain incomplete without duplicate settlement", async () => {
  const callbacks = []
  const buffer = new AuditBuffer({
    maxEventsPerSecond: 1,
    maxBytes: 4096,
    sink: {
      appendBatch: frames =>
        frames.map(() => ({ result: "unknown", reason: "partial-write", sequence: 1 })),
    },
  })
  buffer.offer({ type: "violation" }, { critical: true, onSettled: value => callbacks.push(value) })
  const deadline = createAuditDeadline(100)
  const result = await buffer.close(
    buffer.createClosePermit({ generation: 1, nonce: closeNonce, deadline }),
  )
  assert.equal(result.outcome, "incomplete")
  assert.equal(callbacks.length, 1)
  assert.equal(buffer.stats().criticalWriteFailed, 1)
  assert.equal(
    buffer.offer(
      { type: "audit" },
      {
        onSettled() {
          throw new Error("callback")
        },
      },
    ).reason,
    "after-seal",
  )
  assert.equal(buffer.stats().settlementErrors, 1)
})

test("live rate changes reschedule retained observations without granting a fresh burst", async () => {
  const { buffer, timer, written } = setup(1)
  for (let index = 0; index < 10; index++) buffer.offer({ type: "audit", details: { index } })
  timer.advance(0)
  assert.equal(written.length, 1)
  buffer.updateLimits({ maxEventsPerSecond: 10, maxBytes: 4096 })
  timer.advance(0)
  assert.equal(written.length, 1)
  timer.advance(100)
  assert.equal(written.length, 2)
  buffer.updateLimits({ maxEventsPerSecond: 1, maxBytes: 4096 })
  timer.advance(100)
  assert.equal(written.length, 2)
  timer.advance(900)
  assert.equal(written.length, 3)
  const deadline = createAuditDeadline(1000)
  await buffer.close(buffer.createClosePermit({ generation: 1, nonce: closeNonce, deadline }))
  assert.equal(written.length, 10)
})

test("shrinking byte limits preserves in-flight receipts and the authenticated close cutoff", async () => {
  const timer = clock(),
    receipts = []
  let buffer, injected
  buffer = new AuditBuffer({
    maxEventsPerSecond: 1,
    maxBytes: 4096,
    now: timer.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    sink: {
      appendBatch(frames) {
        buffer.updateLimits({ maxEventsPerSecond: 2, maxBytes: 1024 })
        injected ??= buffer.offer({ type: "audit" })
        return frames.map((_, index) => ({ result: "written", sequence: index + 1, bytes: 700 }))
      },
    },
  })
  for (let index = 0; index < 2; index++)
    buffer.offer(
      { type: "audit", details: { index, text: "x".repeat(600) } },
      { onSettled: receipt => receipts.push(receipt) },
    )
  const deadline = createAuditDeadline(1000)
  const permit = buffer.createClosePermit({ generation: 1, nonce: closeNonce, deadline })
  timer.advance(0)
  assert.equal(injected.reason, "queue-bytes")
  assert.equal(receipts.length, 1)
  assert.equal(buffer.stats().ordinaryPending, 1)
  assert.equal(buffer.createClosePermit({ generation: 1, nonce: closeNonce, deadline }), permit)
  const summary = await buffer.close(permit)
  assert.equal(summary.accelerated, true)
  assert.deepEqual(
    receipts.map(receipt => receipt.result),
    ["written", "written"],
  )
  assert.equal(buffer.stats().pendingRecords, 0)
  buffer.updateLimits({ maxEventsPerSecond: 100, maxBytes: 4096 })
  assert.equal(buffer.offer({ type: "audit" }).reason, "after-seal")
  assert.throws(() => buffer.updateLimits({ maxEventsPerSecond: 0, maxBytes: 4096 }), TypeError)
})

test("a second critical frame falls back to the ordinary queue instead of being dropped", async () => {
  const { buffer, timer, written } = setup()
  assert.equal(
    buffer.offer({ type: "audit", details: { n: 1 } }, { critical: true }).accepted,
    true,
  )
  assert.equal(
    buffer.offer({ type: "audit", details: { n: 2 } }, { critical: true }).accepted,
    true,
  )
  assert.equal(
    buffer.offer({ type: "audit", details: { n: 3 } }, { critical: true }).accepted,
    true,
  )
  timer.advance(0)
  assert.deepEqual(written.map(frame => frame.details.n).sort(), [1, 2, 3])
  assert.equal(buffer.stats().criticalCoalesced, 0)
  const deadline = createAuditDeadline(0)
  await buffer.close(buffer.createClosePermit({ generation: 1, nonce: closeNonce, deadline }))
})
