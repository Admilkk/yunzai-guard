import assert from "node:assert/strict"
import test from "node:test"
import { auditModule, channelNonce, closeNonce, event } from "./audit-core-fixture.mjs"

const { parseAuditFrame, copyAuditData, createAuditDeadline, createAuditSourceCounters } =
  await auditModule("audit/protocol")
const base = { auditProtocol: 1, generation: 1, channelNonce }

test("audit protocol accepts closed audit frames and strips the independently checked IPC pid", () => {
  const observation = { ...base, type: "audit", auditSeq: 1, event: event(), pid: 123 }
  const parsed = parseAuditFrame(observation)
  assert.equal(parsed.type, "audit")
  assert.equal(parsed.pid, undefined)
  assert.equal(parseAuditFrame({ ...observation, command: "restart" }), undefined)
  assert.equal(parseAuditFrame({ ...observation, channelNonce: "wrong" }), undefined)
  assert.equal(parseAuditFrame({ ...observation, generation: 0 }), undefined)
  assert.equal(parseAuditFrame({ ...observation, auditSeq: 0 }), undefined)
})

test("audit seal reports lastSentSeq and bounded complete counters rather than guest runtime authority", () => {
  const frame = {
    ...base,
    type: "audit-seal",
    closeNonce,
    lastSentSeq: 0,
    sourceCounters: createAuditSourceCounters(),
    nestedCoverage: "unknown",
  }
  assert.equal(parseAuditFrame(frame).lastSentSeq, 0)
  assert.equal(parseAuditFrame({ ...frame, lastAcceptedSeq: 0 }), undefined)
  assert.equal(parseAuditFrame({ ...frame, sourceCounters: {} }), undefined)
  frame.sourceCounters.invalidReplies = 4
  assert.equal(parseAuditFrame(frame).sourceCounters.invalidReplies, 4)
  frame.sourceCounters.unknown = -1
  assert.equal(parseAuditFrame(frame), undefined)
})

test("pure flush result refuses impossible prefix order and unbounded deadlines", () => {
  const prepare = {
    ...base,
    type: "audit-prepare-flush",
    closeNonce,
    remainingBudgetMs: 100,
    scope: "this-source-only",
  }
  assert.equal(parseAuditFrame(prepare).remainingBudgetMs, 100)
  assert.equal(parseAuditFrame({ ...prepare, remainingBudgetMs: 120001 }), undefined)
  const result = {
    ...base,
    type: "audit-flush-result",
    closeNonce,
    cutoff: 2,
    scope: "this-source-only",
    outcome: "incomplete",
    receivedThrough: 2,
    settledThrough: 1,
    writtenThrough: 1,
    writtenCount: 1,
    rejectedCount: 0,
    unknownCount: 1,
    remainingCount: 0,
    evidence: "host-append-completed",
  }
  assert.equal(parseAuditFrame(result).evidence, "host-append-completed")
  assert.equal(parseAuditFrame({ ...result, writtenThrough: 2 }), undefined)
  assert.equal(parseAuditFrame({ ...result, evidence: "durable" }), undefined)
  assert.equal(parseAuditFrame({ ...result, writtenCount: 3 }), undefined)
  assert.equal(parseAuditFrame({ ...result, rejectedCount: 3 }), undefined)
  assert.equal(parseAuditFrame({ ...result, remainingCount: 3 }), undefined)
  assert.equal(parseAuditFrame({ ...result, outcome: "all-offered-written" }), undefined)
  const complete = {
    ...result,
    outcome: "all-offered-written",
    settledThrough: 2,
    writtenThrough: 2,
    writtenCount: 2,
    unknownCount: 0,
  }
  assert.equal(parseAuditFrame(complete).outcome, "all-offered-written")
  assert.equal(parseAuditFrame({ ...complete, evidence: "parent-hop-only" }), undefined)
})

test("protocol copying never invokes accessors or proxy traps and bounds sparse arrays and text", () => {
  let reads = 0
  const accessor = {
    get secret() {
      reads++
      return "secret"
    },
  }
  assert.throws(() => copyAuditData(accessor), /拒绝审计访问器属性/)
  assert.throws(
    () =>
      copyAuditData(
        new Proxy(
          {},
          {
            ownKeys() {
              reads++
              return []
            },
          },
        ),
      ),
    /审计数据必须是纯数据/,
  )
  assert.equal(reads, 0)
  assert.throws(() => copyAuditData(new Array(1000000)), /审计数组超长/)
  assert.throws(
    () => copyAuditData({ a: "a".repeat(40000), b: "b".repeat(40000) }),
    /审计字符串超长/,
  )
  const cycle = {}
  cycle.self = cycle
  assert.throws(() => copyAuditData(cycle), /审计数据必须是纯数据/)
})

test("audit deadline is monotonic within the original budget and ignores wall time", () => {
  let monotonic = 10
  const deadline = createAuditDeadline(100, () => monotonic)
  assert.equal(deadline.remainingMs(), 100)
  monotonic += 80
  assert.equal(deadline.remainingMs(), 20)
  monotonic -= 40
  assert.equal(deadline.remainingMs(), 20, "A bad clock sample must not extend the original budget")
  monotonic += 40
  monotonic += 30
  assert.equal(deadline.remainingMs(), 0)
})
