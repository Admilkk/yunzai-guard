import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import sqlite from "node:sqlite"
import test from "node:test"
import { SqliteAuditSink } from "../dist/audit/store.js"
import { readAudit, pluginMonitor } from "../dist/web/monitor.js"
import { parseSettings } from "../dist/config/index.js"

function fixture(t, limits = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-audit-sqlite-"))
  const filePath = path.join(root, "events.sqlite")
  const resources = []
  const open = () => {
    const sink = new SqliteAuditSink({
      filePath,
      maxBytes: 4096,
      maxFiles: 4,
      hostPid: 7,
      ...limits,
    })
    resources.push(sink)
    return sink
  }
  t.after(() => {
    for (const resource of resources) resource.close()
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, filePath, open }
}

function event(plugin, patch = {}) {
  return {
    kind: "network",
    operation: "fetch",
    target: "https://example.test/private?token=must-hide",
    action: "audit",
    plugin,
    ...patch,
  }
}

test("SQLite 事务落盘、重启读取、过滤分页与插件汇总", t => {
  const { root, filePath, open } = fixture(t)
  const sink = open()
  assert.deepEqual(
    sink
      .appendBatch([
        {
          type: "audit",
          details: { sequence: 999, hostPid: 999, event: event("foo-plugin") },
          time: 100,
        },
        {
          type: "audit",
          details: {
            event: event("bar-plugin", {
              action: "deny",
              kind: "process",
              operation: "exec",
              target: "tool password=must-hide",
              details: { authorization: "must-hide" },
              blocked: true,
            }),
          },
          time: 200,
        },
        { type: "audit-retired-summary", details: { unknown: 2 }, time: 300 },
        { type: "audit", details: { event: event("foo-plugin") }, time: 400 },
      ])
      .map(row => row.result),
    ["written", "written", "written", "written"],
  )
  sink.close()
  const database = new sqlite.DatabaseSync(filePath, { readOnly: true })
  try {
    const payload = String(
      database.prepare("SELECT payload FROM events ORDER BY id LIMIT 1").get().payload,
    )
    assert.equal(JSON.parse(payload).hostPid, 7)
    assert.equal(JSON.parse(payload).sequence, 1)
    assert.equal(payload.includes("must-hide"), false)
  } finally {
    database.close()
  }
  const reopened = open()
  assert.equal(reopened.record("host-ready", {}, 500).sequence, 5)
  const page = readAudit(root, { pageSize: 2 })
  assert.equal(page.storage.engine, "sqlite")
  assert.equal(page.storage.available, true)
  assert.equal(page.storage.retainedRecords, 5)
  assert.equal(page.coverage.source, "sqlite-history")
  assert.equal(page.coverage.complete, false)
  assert.equal(page.coverage.lossReported, true)
  assert.equal(page.total, 5)
  assert.equal(page.items.length, 2)
  assert.equal(page.hasMore, true)
  assert.equal(page.summary.audit, 2)
  assert.equal(page.summary.deny, 1)
  assert.equal(
    page.summary.timeline.reduce((sum, row) => sum + row.total, 0),
    5,
  )
  assert.equal(readAudit(root, { page: 2, pageSize: 2 }).items[0].time, 300)
  const filtered = readAudit(root, {
    plugin: "bar-plugin",
    action: "deny",
    from: 200,
    to: 200,
    q: "TOOL",
  })
  assert.equal(filtered.total, 1)
  assert.equal(filtered.items[0].blocked, true)
  assert.equal(JSON.stringify(filtered).includes("must-hide"), false)
  assert.equal(readAudit(root, { plugin: "' OR 1=1 --" }).total, 0)
  fs.mkdirSync(path.join(root, "plugins", "foo-plugin"), { recursive: true })
  fs.mkdirSync(path.join(root, "plugins", "bar-plugin"), { recursive: true })
  const plugins = pluginMonitor(root, parseSettings({}), filtered)
  const foo = plugins.find(row => row.id === "foo-plugin")
  assert.equal(foo.stats.total, 2)
  assert.equal(foo.lastEvent.time, 400)
  assert.equal(foo.statsScope, "sqlite-history")
})

test("SQLite 容量淘汰与热更新保持序号和覆盖信息", t => {
  const { root, open } = fixture(t, { maxBytes: 512, maxFiles: 2 })
  const sink = open()
  for (let time = 0; time < 20; time++)
    assert.equal(sink.record("audit", { note: "a".repeat(240) }, time).result, "written")
  const initial = sink.stats()
  assert.ok(initial.retainedBytes <= 1024)
  assert.ok(initial.evictedRecords > 0)
  sink.updateLimits({ maxBytes: 512, maxFiles: 1 })
  assert.ok(sink.stats().retainedBytes <= 512)
  assert.ok(sink.stats().evictedRecords > initial.evictedRecords)
  sink.close()
  const second = open()
  assert.equal(second.record("host-ready", {}, 21).sequence, 21)
  const page = readAudit(root)
  assert.equal(page.coverage.truncated, true)
  assert.ok(page.storage.evictedRecords > 0)
})

test("SQLite 序列化不执行访问器，拒绝超限并恢复已知失败", t => {
  const { filePath, open } = fixture(t)
  const sink = open()
  let reads = 0
  const receipt = sink.record("audit", {
    get secret() {
      reads++
      return "hidden"
    },
  })
  assert.equal(receipt.reason, "serialization")
  assert.equal(reads, 0)
  assert.equal(
    sink.record("audit", { first: "a".repeat(2048), second: "b".repeat(2048) }).reason,
    "oversize",
  )
  assert.throws(() => sink.appendBatch(Array.from({ length: 257 }, () => ({ type: "audit" }))))
  const lock = new sqlite.DatabaseSync(filePath)
  try {
    lock.exec("BEGIN IMMEDIATE")
    assert.equal(sink.record("audit", {}, 1).reason, "sink-error")
    assert.equal(sink.stats().framingUnknown, false)
    lock.exec("ROLLBACK")
    assert.equal(sink.record("audit", {}, 2).sequence, 2)
    assert.equal(sink.stats().available, true)
  } finally {
    lock.close()
  }
  sink.close()
  assert.equal(sink.record("host-late").reason, "sink-error")
})

test("旧 JSONL 只做有界幂等导入，保留原文件与错误覆盖", t => {
  const { root, open } = fixture(t)
  const legacy = JSON.stringify({
    sequence: 4,
    hostPid: 9,
    time: 100,
    type: "audit",
    event: event("legacy-plugin"),
  })
  const file = path.join(root, "events.jsonl")
  fs.writeFileSync(file, legacy + "\n{partial\n")
  fs.writeFileSync(
    file + ".1",
    JSON.stringify(JSON.parse(legacy), null, 0).replace(/,/g, ", ") + "\n",
  )
  const sink = open()
  assert.equal(sink.stats().retainedRecords, 1)
  assert.equal(sink.record("host-ready", {}, 200).sequence, 5)
  const first = readAudit(root)
  assert.equal(first.storage.legacyImported, 1)
  assert.equal(first.coverage.invalidLines, 1)
  assert.equal(first.total, 2)
  sink.close()
  open()
  assert.equal(readAudit(root).total, 2)
  assert.equal(fs.readFileSync(file, "utf8"), legacy + "\n{partial\n")
})

test("旧 JSONL 超出导入窗口不会伪造完整历史", t => {
  const { root, open } = fixture(t)
  fs.writeFileSync(
    path.join(root, "events.jsonl"),
    "\n".repeat(4 * 1024 * 1024 + 1) +
      JSON.stringify({ sequence: 1, hostPid: 9, time: 1, type: "audit" }) +
      "\n",
  )
  open()
  const page = readAudit(root)
  assert.equal(page.total, 1)
  assert.equal(page.coverage.truncated, true)
  assert.equal(page.coverage.complete, false)
})

test("数据库与 sidecar 拒绝硬链接，存在但损坏的数据库不回退旧日志", t => {
  const { root, filePath, open } = fixture(t)
  const sink = open()
  sink.record("audit", {}, 1)
  sink.close()
  const link = path.join(root, "audit-hardlink.sqlite")
  fs.linkSync(filePath, link)
  assert.throws(
    () => new SqliteAuditSink({ filePath, maxBytes: 4096, maxFiles: 1 }),
    /审计库必须是单链接普通文件/,
  )
  assert.equal(readAudit(root).storage.available, false)
  fs.unlinkSync(link)
  const sidecarSource = path.join(root, "foreign")
  fs.writeFileSync(sidecarSource, "unrelated")
  fs.linkSync(sidecarSource, filePath + "-wal")
  assert.throws(
    () => new SqliteAuditSink({ filePath, maxBytes: 4096, maxFiles: 1 }),
    /审计库必须是单链接普通文件/,
  )
  fs.unlinkSync(filePath + "-wal")
  fs.writeFileSync(filePath, "corrupt")
  fs.writeFileSync(
    path.join(root, "events.jsonl"),
    JSON.stringify({ time: 1, type: "legacy" }) + "\n",
  )
  const failed = readAudit(root)
  assert.equal(failed.total, 0)
  assert.equal(failed.storage.available, false)
  assert.equal(failed.coverage.errors.length, 1)
})
