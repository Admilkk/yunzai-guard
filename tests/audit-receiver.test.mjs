import assert from "node:assert/strict"
import test from "node:test"
import { auditModule, channelNonce, closeNonce, clock, event } from "./audit-core-fixture.mjs"

const { AuditReceiver } = await auditModule("audit/receiver")
const { AuditBuffer } = await auditModule("audit/buffer")
const { createAuditDeadline, createAuditSourceCounters, parseAuditFrame } =
  await auditModule("audit/protocol")
const immediate = () => new Promise(resolve => setImmediate(resolve))
async function waitReceipt(state) {
  await state.receiver.flush()
  const deadline = Date.now() + 3000
  while (!state.result() && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 1))
  assert.ok(state.result(), "Expected the independently scheduled Host receipt")
}
function setup(options = {}) {
  const timer = clock(),
    rows = [],
    actions = [],
    replies = []
  let sequence = 0
  const buffer = new AuditBuffer({
    sink: {
      appendBatch(frames) {
        rows.push(...frames)
        return frames.map(() =>
          options.partial
            ? { result: "unknown", reason: "partial-write", sequence: ++sequence }
            : { result: "written", sequence: ++sequence, bytes: 100 },
        )
      },
    },
    maxEventsPerSecond: options.rate ?? 100,
    maxBytes: 10 * 1024 * 1024,
    now: timer.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  })
  const receiver = new AuditReceiver({
    generation: 1,
    buffer,
    authorize: options.authorize ?? (value => value),
    onAction: options.onAction ?? (value => actions.push(value)),
  })
  receiver.register("primary", channelNonce, "primary-ipc")
  const deadline = createAuditDeadline(options.budgetMs ?? 2000)
  const close = { nonce: closeNonce, deadline }
  receiver.prepare(close)
  const reply = frame => replies.push(frame)
  const offer = (index, value = event(), nonce = channelNonce, key = "primary") =>
    receiver.receive(
      key,
      {
        auditProtocol: 1,
        generation: 1,
        channelNonce: nonce,
        type: "audit",
        auditSeq: index,
        event: value,
      },
      reply,
    )
  const seal = (lastSentSeq, changes = {}, key = "primary", nonce = channelNonce) => {
    const sourceCounters = {
      ...createAuditSourceCounters(),
      offered: lastSentSeq,
      accepted: lastSentSeq,
      sendCompleted: lastSentSeq,
      hopReceived: lastSentSeq,
      ...changes,
    }
    return receiver.receive(
      key,
      {
        auditProtocol: 1,
        generation: 1,
        channelNonce: nonce,
        type: "audit-seal",
        closeNonce,
        lastSentSeq,
        sourceCounters,
        nestedCoverage: "settled",
      },
      reply,
    )
  }
  return {
    timer,
    rows,
    actions,
    replies,
    receiver,
    buffer,
    offer,
    seal,
    close,
    result: () => replies.find(frame => frame.type === "audit-flush-result"),
  }
}

test("one Host close permit drains 1665 observed records under the unchanged 100/s steady limit", async () => {
  const state = setup()
  for (let index = 1; index <= 1665; index++) assert.equal(state.offer(index), true)
  state.timer.advance(0)
  assert.equal(state.rows.length, 100)
  assert.equal(state.seal(1665), true)
  await waitReceipt(state)
  const receipt = state.result()
  assert.equal(receipt.outcome, "all-offered-written")
  assert.equal(receipt.writtenThrough, 1665)
  assert.equal(state.rows.length, 1665)
  assert.ok(parseAuditFrame(receipt))
  assert.equal(state.buffer.stats().dropped, 0)
  await state.buffer.close(state.receiver.closePermitForHost())
})

test("channel, generation, and close nonce cannot be replaced by a sibling source", async () => {
  const state = setup()
  state.receiver.register("peer", "c".repeat(48), "broker-connection")
  assert.equal(state.offer(1, event(), "c".repeat(48)), false)
  assert.equal(state.offer(1, event(), channelNonce, "peer"), false)
  assert.equal(state.offer(1), true)
  assert.equal(state.seal(1), true)
  assert.equal(state.seal(1), false)
  assert.equal(state.offer(2), false)
  await waitReceipt(state)
  assert.equal(state.actions.length, 1)
  assert.equal(state.result().outcome, "incomplete")
  await state.buffer.close(state.receiver.closePermitForHost())
})

test("Host authorization determines the action even when a wire observation claims restart", async () => {
  const state = setup({ authorize: value => ({ ...value, action: "audit" }) })
  state.offer(1, event("restart"))
  state.seal(1)
  await waitReceipt(state)
  assert.equal(state.actions[0].action, "audit")
  assert.equal(state.rows[0].type, "audit")
  assert.equal(state.result().outcome, "all-offered-written")
  await state.buffer.close(state.receiver.closePermitForHost())
})

test("queue saturation and critical evidence coalescing do not suppress immediate authorized actions", async () => {
  const state = setup()
  for (let index = 1; index <= 4100; index++) state.offer(index)
  state.offer(4101, event("deny"))
  state.offer(4102, event("restart"))
  assert.equal(state.actions.length, 4102)
  assert.equal(state.actions.at(-1).action, "restart")
  state.seal(4102)
  await waitReceipt(state)
  assert.equal(state.result().outcome, "settled-with-loss")
  assert.equal(state.result().rejectedCount, 5)
  assert.ok(parseAuditFrame(state.result()))
  await state.buffer.close(state.receiver.closePermitForHost())
})

test("priority append order advances per-source written prefix only after the ordinary gap settles", async () => {
  const state = setup()
  state.offer(1)
  state.offer(2, event("deny"))
  state.seal(2)
  await waitReceipt(state)
  assert.equal(state.rows[0].event, undefined)
  assert.equal(state.rows[0].details.event.action, "deny")
  assert.equal(state.result().writtenThrough, 2)
  assert.equal(state.result().settledThrough, 2)
  await state.buffer.close(state.receiver.closePermitForHost())
})

test("missing or partially appended records permanently block complete prefix claims", async () => {
  const state = setup({ partial: true })
  state.offer(1)
  state.offer(3)
  state.seal(3)
  await waitReceipt(state)
  const receipt = state.result()
  assert.equal(receipt.outcome, "incomplete")
  assert.equal(receipt.receivedThrough, 1)
  assert.equal(receipt.settledThrough, 0)
  assert.equal(receipt.writtenThrough, 0)
  assert.equal(receipt.writtenCount, 0)
  assert.ok(receipt.unknownCount >= 3)
  assert.ok(parseAuditFrame(receipt))
  await state.buffer.close(state.receiver.closePermitForHost())
})

test("unsent accepted records and unknown nested coverage cannot produce a complete Host receipt", async () => {
  const state = setup()
  state.offer(1)
  state.seal(1, {
    offered: 100,
    accepted: 100,
    pendingRecords: 99,
    pendingBytes: 99,
    highWaterRecords: 100,
    highWaterBytes: 100,
  })
  await waitReceipt(state)
  assert.equal(state.result().outcome, "incomplete")
  assert.equal(state.result().remainingCount, 0)
  assert.ok(parseAuditFrame(state.result()))
  await state.buffer.close(state.receiver.closePermitForHost())
})

test("a disconnected source with no seal remains explicitly incomplete", async () => {
  const state = setup()
  state.offer(1)
  state.receiver.drop("primary", 1)
  assert.equal(state.offer(2), false)
  await state.receiver.flush()
  const source = state.receiver.stats().sources[0]
  assert.equal(source.sealed, false)
  assert.equal(source.outcome, "incomplete")
  assert.ok(source.unknown >= 1)
  await state.buffer.close(state.receiver.closePermitForHost())
})

test("a pending gap plus 50000 known rejections uses compressed bounded prefix ranges", async () => {
  // 预算在入队前创建；慢速 CI 上 50000 次入队本身可能超过 2 秒。
  const state = setup({ budgetMs: 30000 })
  for (let index = 1; index <= 50000; index++) state.offer(index)
  const pending = state.receiver.stats().sources[0]
  assert.equal(pending.pending, 4096)
  assert.ok(pending.bookkeepingRanges <= 2)
  state.seal(50000)
  await waitReceipt(state)
  assert.equal(state.result().settledThrough, 50000)
  assert.equal(state.result().writtenThrough, 4096)
  assert.equal(state.result().rejectedCount, 50000 - 4096)
  await state.buffer.close(state.receiver.closePermitForHost())
})

test("1000 sequential short lived sources retire without exhausting the active-source bound", async () => {
  const state = setup()
  for (let index = 0; index < 1000; index++) {
    const key = `connection:${index}`
    state.receiver.register(key, "c".repeat(48), "broker-connection")
    state.receiver.drop(key)
  }
  const status = state.receiver.stats()
  assert.equal(status.sources.length, 1)
  assert.equal(status.retired.sources, 1000)
  assert.equal(status.retired.missingSeal, 1000)
  assert.equal(status.retired.incomplete, 1000)
  await state.buffer.close(state.receiver.closePermitForHost())
})

test("Host append proof does not require both callback-completed and hop-completed sender counters", async () => {
  const state = setup()
  state.offer(1)
  state.seal(1, { hopReceived: 0 })
  await waitReceipt(state)
  assert.equal(state.result().outcome, "all-offered-written")
  assert.equal(state.result().evidence, "host-append-completed")
  await state.buffer.close(state.receiver.closePermitForHost())
})

test("deadline exceeded during complete synchronous append keeps written facts and refuses timely completeness", async () => {
  const state = setup()
  let remaining = 10
  const deadline = { remainingMs: () => remaining }
  // 同一 Host nonce 复用原始截止时间，收到回执也不能续期。
  const other = new AuditReceiver({
    generation: 2,
    buffer: state.buffer,
    authorize: value => value,
    onAction: () => {},
  })
  other.register("primary", channelNonce, "primary-ipc")
  other.prepare({ nonce: closeNonce, deadline })
  const replies = []
  other.receive(
    "primary",
    { auditProtocol: 1, generation: 2, channelNonce, type: "audit", auditSeq: 1, event: event() },
    frame => replies.push(frame),
  )
  state.timer.advance(0)
  assert.equal(state.rows.length, 1)
  remaining = 0
  other.receive(
    "primary",
    {
      auditProtocol: 1,
      generation: 2,
      channelNonce,
      type: "audit-seal",
      closeNonce,
      lastSentSeq: 1,
      nestedCoverage: "settled",
      sourceCounters: {
        ...createAuditSourceCounters(),
        offered: 1,
        accepted: 1,
        sendCompleted: 1,
        hopReceived: 1,
      },
    },
    frame => replies.push(frame),
  )
  await immediate()
  const receipt = replies.find(frame => frame.type === "audit-flush-result")
  assert.equal(receipt.writtenCount, 1)
  assert.equal(receipt.outcome, "incomplete")
  assert.equal(other.stats().sources[0].deadlineExceeded, true)
  await state.buffer.close(other.closePermitForHost())
})

test("invalid replies, nonfinite transport counters, and throwing Host callbacks remain explicit unknowns", async () => {
  for (const options of [
    {
      authorize: () => {
        throw new Error("bad authorization")
      },
    },
    {
      onAction: () => {
        throw new Error("bad policy callback")
      },
    },
  ]) {
    const state = setup(options)
    assert.equal(state.offer(1), false)
    state.seal(1)
    await waitReceipt(state)
    assert.equal(state.result().outcome, "incomplete")
    assert.equal(state.result().writtenCount, 0)
    assert.ok(state.result().unknownCount > 0)
    await state.buffer.close(state.receiver.closePermitForHost())
  }
  const invalid = setup()
  invalid.offer(1)
  invalid.seal(1, { invalidReplies: Number.MAX_SAFE_INTEGER })
  await waitReceipt(invalid)
  assert.equal(invalid.result().outcome, "incomplete")
  assert.ok(Number.isSafeInteger(invalid.result().unknownCount))
  invalid.receiver.drop("primary", Infinity)
  assert.equal(invalid.receiver.stats().sources[0].transportUnknown, Number.MAX_SAFE_INTEGER)
  assert.equal(invalid.receiver.stats().sources[0].receiptDelivery, "unconfirmed")
  await invalid.buffer.close(invalid.receiver.closePermitForHost())
})

test("a first seal with no pending rows still fixes the one accelerated admission cutoff", async () => {
  const state = setup()
  state.offer(1)
  state.timer.advance(0)
  assert.equal(state.seal(1), true)
  const cutoff = state.receiver.closePermitForHost().acceleratedCutoff
  state.receiver.register("peer", "c".repeat(48), "broker-connection")
  state.offer(1, event(), "c".repeat(48), "peer")
  assert.equal(cutoff, 1)
  assert.equal(state.receiver.closePermitForHost().acceleratedCutoff, cutoff)
  assert.ok(state.buffer.stats().lastAdmissionSerial > cutoff)
  await waitReceipt(state)
  await state.buffer.close(state.receiver.closePermitForHost())
})

test("retiring a sealed peer retains source-local losses and unknown tails separately from Host rejections", async () => {
  const state = setup()
  const nonce = "c".repeat(48)
  state.receiver.register("peer", nonce, "broker-connection")
  state.offer(1, event(), nonce, "peer")
  const rejected = { ...createAuditSourceCounters().rejected, deadline: 1, "queue-records": 1 }
  state.seal(
    2,
    { offered: 4, accepted: 2, unknown: 1, criticalCoalesced: 1, rejected },
    "peer",
    nonce,
  )
  await waitReceipt(state)
  assert.equal(state.result().outcome, "incomplete")
  state.receiver.drop("peer")
  await immediate()
  const totals = state.receiver.stats().retired
  assert.equal(totals.sources, 1)
  assert.equal(totals.written, 1)
  assert.equal(totals.rejected, 0)
  assert.equal(totals.sourceRejected, 2)
  assert.equal(totals.sourceCoalesced, 1)
  assert.ok(totals.unknown >= 2)
  assert.equal(totals.incomplete, 1)
  await state.buffer.close(state.receiver.closePermitForHost())
})

test("known outbound failures remain visible after sealing or disconnect, including retired peer outcomes", async () => {
  const state = setup()
  state.offer(1)
  state.seal(1)
  await waitReceipt(state)
  assert.equal(state.receiver.stats().sources[0].outcome, "all-offered-written")
  state.receiver.noteOutboundFailure("primary")
  state.receiver.drop("primary")
  state.receiver.noteOutboundFailure("primary")
  const primary = state.receiver.stats().sources[0]
  assert.equal(primary.transportUnknown, 2)
  assert.equal(primary.written, 1)
  assert.equal(primary.outcome, "incomplete")

  const nonce = "c".repeat(48)
  state.receiver.register("peer", nonce, "broker-connection")
  state.receiver.noteOutboundFailure("peer")
  state.seal(0, {}, "peer", nonce)
  state.receiver.drop("peer")
  await immediate()
  assert.equal(state.receiver.stats().retired.incomplete, 1)
  assert.equal(state.receiver.stats().retired.unknown, 1)
  state.receiver.drop("primary", Number.MAX_SAFE_INTEGER)
  state.receiver.noteOutboundFailure("primary")
  assert.equal(state.receiver.stats().sources[0].transportUnknown, Number.MAX_SAFE_INTEGER)
  await state.buffer.close(state.receiver.closePermitForHost())
})
