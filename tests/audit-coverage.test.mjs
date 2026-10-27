import assert from "node:assert/strict"
import test from "node:test"
import { auditModule, memoryIO } from "./audit-core-fixture.mjs"

const { auditCoverageRecords } = await auditModule("audit/coverage")
const { AuditSink } = await auditModule("audit/sink")

test("coverage persists every active channel and nested loss counters as bounded flat records", () => {
  const io = memoryIO()
  const sink = new AuditSink({ filePath: "events", maxBytes: 1024 * 1024, maxFiles: 2, io })
  const sources = Array.from({ length: 35 }, (_, index) => ({
    sourceId: index + 1,
    transport: index ? "broker-connection" : "primary-ipc",
    received: index + 8,
    receivedThrough: index + 2,
    written: index + 1,
    rejected: 2,
    unknown: 3,
    sourceLoss: { unknown: 3, rejected: index + 4, coalesced: 5, pendingRecords: 6 },
    transportUnknown: 7,
    pending: 1,
    sealed: true,
    bookkeepingRanges: 2,
    deadlineExceeded: false,
    receiptDelivery: "unconfirmed",
    outcome: "incomplete",
    nestedCoverage: "unknown",
    evidence: "host-append-completed",
    dropped: false,
    unexpected: "secret",
  }))
  const retired = {
    sources: 400,
    sealed: 390,
    missingSeal: 10,
    written: 10,
    rejected: 11,
    unknown: 12,
    sourceRejected: 13,
    sourceCoalesced: 14,
    sourcePendingRecords: 15,
    allOfferedWritten: 100,
    settledWithLoss: 290,
    incomplete: 10,
    unexpected: "secret",
  }
  for (const row of auditCoverageRecords(
    { generation: 2, invalidFrames: 3, sources, retired },
    "host-stop",
  ))
    assert.equal(sink.record(row.type, row.details).result, "written")
  const rows = io.files
    .get("events")
    .trim()
    .split("\n")
    .map(text => JSON.parse(text))
  assert.equal(rows.length, 37)
  assert.equal(rows[0].activeSources, 35)
  assert.equal(rows[0].retiredDetail, "aggregate-only")
  assert.equal(rows[1].sourcePendingRecords, 15)
  assert.equal(rows.at(-1).sourceId, 35)
  assert.equal(rows.at(-1).sourceRejected, 38)
  assert.equal(rows.at(-1).sourcePendingRecords, 6)
  assert.equal(rows.at(-1).transportCounterUnit, "channel-incidents-not-records")
  assert.equal(
    rows.every(row => row.generation === 2 && row.stage === "host-stop"),
    true,
  )
  assert.doesNotMatch(io.files.get("events"), /secret|depth limit/)
})
