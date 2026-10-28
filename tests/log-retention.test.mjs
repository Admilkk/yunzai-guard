import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SqliteAuditSink } from "../dist/audit/store.js"
import { pruneHostLog } from "../dist/host/log.js"
import { parseSettings } from "../dist/config/index.js"
import { planSettingsUpdate } from "../dist/config/update.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "guard-retention-"))
const day = 86400000

test("audit events older than the retention days are removed and newer ones stay", () => {
  const directory = tmp()
  const sink = new SqliteAuditSink({
    filePath: path.join(directory, "events.sqlite"),
    maxBytes: 1024 * 1024,
    maxFiles: 3,
  })
  try {
    const now = Date.now()
    sink.appendBatch([
      { type: "audit", details: { n: 1 }, time: now - 10 * day },
      { type: "audit", details: { n: 2 }, time: now - 8 * day },
      { type: "audit", details: { n: 3 }, time: now - 1 * day },
    ])
    assert.equal(sink.pruneByAge(0, now), 0)
    assert.equal(sink.stats().retainedRecords, 3)
    assert.equal(sink.pruneByAge(7, now), 2)
    assert.equal(sink.stats().retainedRecords, 1)
    assert.equal(sink.pruneByAge(7, now), 0)
  } finally {
    sink.close()
  }
})

test("host log files are removed only after staying untouched past the retention days", () => {
  const directory = tmp()
  const current = path.join(directory, "host.log")
  const rotated = `${current}.1`
  fs.writeFileSync(current, "now")
  fs.writeFileSync(rotated, "old")
  const old = new Date(Date.now() - 10 * day)
  fs.utimesSync(rotated, old, old)
  assert.equal(pruneHostLog(directory, 0), 0)
  assert.equal(pruneHostLog(directory, 7), 1)
  assert.equal(fs.existsSync(current), true)
  assert.equal(fs.existsSync(rotated), false)
  assert.equal(pruneHostLog(directory, 7, Date.now() + 30 * day), 1)
  assert.equal(fs.existsSync(current), false)
})

test("retention settings default to size-only and apply without a restart except the log size", () => {
  const settings = parseSettings({})
  assert.equal(settings.audit.maxDays, 0)
  assert.deepEqual({ ...settings.log }, { maxBytes: 4194304, maxDays: 0 })
  assert.throws(() => parseSettings({ log: { maxBytes: 100 } }))
  assert.throws(() => parseSettings({ audit: { maxDays: -1 } }))
  const days = planSettingsUpdate(
    settings,
    parseSettings({ audit: { maxDays: 30 }, log: { maxDays: 14 } }),
  )
  assert.deepEqual(days.liveFields.sort(), ["audit.maxDays", "log.maxDays"])
  assert.deepEqual(days.restartFields, [])
  assert.equal(days.live.audit.maxDays, 30)
  const size = planSettingsUpdate(settings, parseSettings({ log: { maxBytes: 1048576 } }))
  assert.deepEqual(size.restartFields, ["log.maxBytes"])
  assert.equal(size.candidate.log.maxBytes, 4194304)
})
