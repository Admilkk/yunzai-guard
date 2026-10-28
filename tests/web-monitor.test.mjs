import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { readAudit, pluginMonitor } from "../dist/web/monitor.js"
import { parseSettings } from "../dist/config/index.js"

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-web-monitor-"))
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

function event(sequence, plugin, patch = {}) {
  return {
    sequence,
    hostPid: 1,
    generation: 1,
    time: sequence * 100,
    type: "audit",
    event: {
      kind: "network",
      operation: "fetch",
      target: "https://example.test/private?token=must-hide",
      action: "audit",
      ...(plugin ? { plugin } : {}),
      ...patch,
    },
  }
}

test("审计读取真实宿主信封与轮转，过滤分页并保留覆盖不足和脱敏详情", t => {
  const root = fixture(t)
  const rows = [
    event(1, "foo-plugin"),
    event(2, "bar-plugin", {
      kind: "process",
      operation: "exec",
      target: "tool password=must-hide",
      action: "deny",
      blocked: true,
      details: { authorization: "must-hide", note: "Bearer must-hide" },
    }),
    {
      sequence: 3,
      hostPid: 1,
      generation: 1,
      time: 300,
      type: "audit-retired-summary",
      unknown: 2,
      incomplete: 1,
    },
    event(4),
  ]
  fs.writeFileSync(
    path.join(root, "events.jsonl"),
    rows.map(row => JSON.stringify(row)).join("\n") + "\n{partial",
  )
  fs.writeFileSync(
    path.join(root, "events.jsonl.1"),
    JSON.stringify({ ...event(5, "foo-plugin"), time: 50 }) + "\n",
  )
  const result = readAudit(root, { pageSize: 1 })
  assert.equal(result.total, 5)
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].plugin, "unknown")
  assert.equal(result.hasMore, true)
  assert.equal(result.summary.audit, 3)
  assert.equal(result.summary.deny, 1)
  assert.equal(
    result.summary.timeline.reduce((sum, bucket) => sum + bucket.total, 0),
    5,
  )
  assert.ok(result.summary.timeline.length <= 24)
  assert.equal(result.coverage.invalidLines, 1)
  assert.equal(result.coverage.complete, false)
  assert.equal(result.coverage.lossReported, true)
  assert.equal(result.coverage.latestReports[0].details.unknown, 2)
  assert.equal(result.coverage.filesRead, 2)
  assert.equal(result.coverage.windowStart, 50)
  const filtered = readAudit(
    root,
    new URLSearchParams({
      plugin: "bar-plugin",
      action: "deny",
      from: "200",
      to: "200",
      q: "TOOL",
    }),
  )
  assert.equal(filtered.total, 1)
  assert.equal(filtered.items[0].blocked, true)
  assert.equal(JSON.stringify(filtered).includes("must-hide"), false)
  assert.equal(filtered.items[0].details.event.details.authorization, "[redacted]")
  assert.ok(
    readAudit(root).items.some(item => item.target === "https://example.test/[path-redacted]"),
  )
  const stable = result.items[0].id
  fs.writeFileSync(
    path.join(root, "events.jsonl"),
    rows
      .concat(event(6, "foo-plugin"))
      .map(row => JSON.stringify(row))
      .join("\n") + "\n",
  )
  assert.equal(
    readAudit(root, { q: "fetch", pageSize: 100 }).items.find(item => item.sequence === 4).id,
    stable,
  )
})

test("插件统计使用完整读取窗口，首条规则优先且未知归因不分配给插件", t => {
  const root = fixture(t)
  for (const id of ["foo-plugin", "bar-plugin", "yunzai-guard"])
    fs.mkdirSync(path.join(root, "plugins", id), { recursive: true })
  fs.writeFileSync(
    path.join(root, "events.jsonl"),
    [event(1, "foo-plugin"), event(2, "foo-plugin"), event(3, "bar-plugin"), event(4)]
      .map(row => JSON.stringify(row))
      .join("\n"),
  )
  const settings = parseSettings({
    rules: [
      { id: "global-first", kind: "network", action: "audit" },
      { id: "plugin-later", plugin: "foo-*", kind: "network", action: "deny" },
    ],
  })
  const page = readAudit(root, { pageSize: 1 })
  const plugins = pluginMonitor(root, settings, page)
  const foo = plugins.find(plugin => plugin.id === "foo-plugin")
  assert.equal(foo.stats.total, 2)
  assert.equal(foo.statsScope, "retained-window")
  assert.equal(foo.lastEvent.plugin, "foo-plugin")
  assert.deepEqual(
    foo.rules.map(rule => rule.id),
    ["global-first", "plugin-later"],
  )
  assert.equal(foo.permissions.find(permission => permission.id === "network").action, "audit")
  assert.equal(
    foo.permissions.find(permission => permission.id === "network").ruleId,
    "global-first",
  )
  assert.equal(
    foo.permissions.find(permission => permission.id === "hook").enforcement,
    "after-change",
  )
  assert.equal(
    plugins.reduce((sum, plugin) => sum + plugin.stats.total, 0),
    3,
  )
  assert.equal(plugins.find(plugin => plugin.id === "yunzai-guard").reserved, true)
})

test("审计窗口限制读取量，拒绝非法筛选且不跟随事件文件符号链接", t => {
  const root = fixture(t)
  const outside = path.join(root, "private.txt")
  fs.writeFileSync(outside, "must-not-read")
  fs.symlinkSync(
    process.platform === "win32" ? root : outside,
    path.join(root, "events.jsonl"),
    process.platform === "win32" ? "junction" : "file",
  )
  const skipped = readAudit(root)
  assert.equal(skipped.total, 0)
  assert.equal(skipped.coverage.filesSkipped, 1)
  for (const query of [
    { page: 0 },
    { pageSize: 101 },
    { action: "allow" },
    { path: outside },
    { from: "invalid" },
    { from: 200, to: 100 },
  ])
    assert.throws(() => readAudit(root, query), TypeError)
  fs.unlinkSync(path.join(root, "events.jsonl"))
  fs.writeFileSync(
    path.join(root, "events.jsonl"),
    "x".repeat(4 * 1024 * 1024) + "\n" + JSON.stringify(event(1, "foo-plugin")) + "\n",
  )
  const bounded = readAudit(root)
  assert.equal(bounded.coverage.truncated, true)
  assert.ok(bounded.coverage.bytesRead <= 4 * 1024 * 1024)
  assert.equal(bounded.total, 1)
})
