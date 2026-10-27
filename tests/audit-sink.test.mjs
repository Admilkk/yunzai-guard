import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { auditModule, memoryIO } from "./audit-core-fixture.mjs"

const { AuditSink } = await auditModule("audit/sink")

test("sink batches complete frames, preserves envelope authority, and bounds rotation", () => {
  const io = memoryIO()
  const sink = new AuditSink({ filePath: "events", maxBytes: 230, maxFiles: 2, io, hostPid: 7 })
  const receipts = sink.appendBatch(
    Array.from({ length: 7 }, (_, index) => ({
      type: "audit",
      details: { index, sequence: 999, hostPid: 999 },
      time: index,
    })),
  )
  assert.equal(receipts.filter(row => row.result === "written").length, 7)
  assert.deepEqual(
    receipts.map(row => row.sequence),
    [1, 2, 3, 4, 5, 6, 7],
  )
  assert.equal(io.files.size, 2)
  for (const text of io.files.values()) {
    assert.ok(Buffer.byteLength(text) <= 230)
    for (const line of text.trim().split("\n")) assert.equal(JSON.parse(line).hostPid, 7)
  }
  assert.ok(sink.stats().filesEvicted > 0)
  assert.equal(sink.stats().evidence, "append-completed-without-fsync")
})

test("sink preserves partial error bytes and never acknowledges the failed batch or repairs its framing", () => {
  const io = memoryIO()
  io.append = (name, text) => {
    io.files.set(name, text.slice(0, 13))
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" })
  }
  const sink = new AuditSink({ filePath: "events", maxBytes: 4096, maxFiles: 2, io })
  const first = sink.appendBatch([{ type: "audit" }, { type: "violation" }])
  assert.deepEqual(
    first.map(row => row.result),
    ["unknown", "unknown"],
  )
  const bytes = io.files.get("events")
  assert.equal(bytes.length, 13)
  assert.equal(sink.record("host-stop").result, "rejected")
  assert.equal(io.files.get("events"), bytes)
  assert.equal(sink.stats().lastAllocatedSequence, 2)
  assert.equal(sink.stats().framingUnknown, true)
})

test("known metadata failure leaves a sequence gap and a later append cannot reuse it", () => {
  const io = memoryIO()
  let failed = false
  io.exists = name => {
    if (!failed) {
      failed = true
      throw new Error("stat unavailable")
    }
    return io.files.has(name)
  }
  const sink = new AuditSink({ filePath: "events", maxBytes: 4096, maxFiles: 1, io })
  assert.equal(sink.record("audit").result, "rejected")
  const receipt = sink.record("host-stop")
  assert.equal(receipt.sequence, 2)
  assert.equal(JSON.parse(io.files.get("events")).sequence, 2)
  assert.equal(sink.stats().unknown, 0)
})

test("sink rejects oversized evidence and accessors before any append", () => {
  const io = memoryIO()
  const sink = new AuditSink({ filePath: "events", maxBytes: 100, maxFiles: 1, io })
  assert.equal(sink.record("audit", { text: "a".repeat(200) }).reason, "oversize")
  let reads = 0
  assert.equal(
    sink.record("audit", {
      get secret() {
        reads++
        return 1
      },
    }).reason,
    "serialization",
  )
  assert.equal(reads, 0)
  assert.equal(io.files.size, 0)
})

test("real filesystem append remains readable without claiming a persistent or rotation-proof receipt", () => {
  fs.mkdirSync(fileURLToPath(new URL("./runs", import.meta.url)), { recursive: true })
  const root = fs.mkdtempSync(fileURLToPath(new URL("./runs/audit-sink-unit-", import.meta.url)))
  const filePath = path.join(root, "events.jsonl")
  const sink = new AuditSink({ filePath, maxBytes: 4096, maxFiles: 1 })
  assert.equal(sink.record("audit", { generation: 1 }, 5).result, "written")
  const row = JSON.parse(fs.readFileSync(filePath, "utf8"))
  assert.equal(row.generation, 1)
  assert.equal(row.time, 5)
  assert.equal(sink.stats().evidence.includes("without-fsync"), true)
})
