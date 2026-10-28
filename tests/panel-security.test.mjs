import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseSettings } from "../dist/config/index.js"
import { AlertService } from "../dist/host/alerts.js"
import { ResourceHistory, cpuTime } from "../dist/host/usage.js"
import { isLocalAddress } from "../dist/web/network.js"
import { PanelAuth } from "../dist/web/auth.js"
import { loadPanelSettings } from "../dist/web/panel-settings.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "guard-panel-security-"))
const lan = {
  eth0: [{ address: "203.0.113.5", family: "IPv4", cidr: "203.0.113.5/24", internal: false }],
  eth1: [
    {
      address: "2408:8000:1:2::10",
      family: "IPv6",
      cidr: "2408:8000:1:2::10/64",
      internal: false,
    },
  ],
}

test("本机、私有网段与同网卡子网视为局域网，其余视为外网", () => {
  for (const address of [
    "127.0.0.1",
    "::1",
    "10.1.2.3",
    "172.16.0.9",
    "192.168.1.20",
    "169.254.1.1",
    "100.64.0.8",
    "fe80::1",
    "fd12:3456::1",
    "203.0.113.77",
    "2408:8000:1:2::abcd",
  ])
    assert.equal(isLocalAddress(address, lan), true, address)
  for (const address of ["8.8.8.8", "172.32.0.1", "203.0.114.1", "2408:8000:1:3::1", "unknown", ""])
    assert.equal(isLocalAddress(address, lan), false, address)
})

test("面板默认不开放外网，且旧配置读取后补全该项", () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, "panel.json"), JSON.stringify({ port: 22000 }))
  const settings = loadPanelSettings(dir)
  assert.equal(settings.allowExternal, false)
  assert.equal(settings.port, 22000)
})

test("登录连续失败会上报失败与封禁事件", () => {
  const events = []
  const dir = tmp()
  const settings = loadPanelSettings(dir)
  const auth = new PanelAuth(() => settings, dir, {
    failed: address => events.push(["failed", address]),
    blocked: (address, seconds) => events.push(["blocked", address, seconds]),
  })
  auth.requestCode()
  for (let index = 0; index < 8; index++)
    assert.throws(() => auth.checkCode("WRONG", "198.51.100.9"))
  assert.equal(events.filter(item => item[0] === "failed").length, 8)
  assert.deepEqual(events.at(-1), ["blocked", "198.51.100.9", 300])
})

function alerts(on = {}) {
  const sent = []
  const dir = tmp()
  const settings = parseSettings({ alerts: { on } })
  const make = () =>
    new AlertService({
      settings: () => settings,
      stateDir: dir,
      projectId: "test",
      send: text => (sent.push(text), true),
      record() {},
    })
  return { service: make(), make, sent, dir }
}

test("告警带编号，可标记已读，状态重启后保留", () => {
  const { service, make } = alerts()
  service.raise("deny", "甲", "拦截甲", { key: "a" })
  service.raise("deny", "乙", "拦截乙", { key: "b" })
  const [second, first] = service.history()
  assert.ok(first.id && second.id && first.id !== second.id)
  service.acknowledge([first.id])
  assert.deepEqual(make().state().read, [first.id])
  service.acknowledge()
  assert.ok(make().state().readBefore > 0)
})

test("静默插件或类别后只留历史，不再推送，可取消", () => {
  const { service, sent } = alerts()
  service.mute({ plugin: "bad-plugin" }, 10)
  service.raise("deny", "x", "被静默", { key: "m1", plugin: "bad-plugin" })
  service.raise("deny", "y", "不受影响", { key: "m2", plugin: "other" })
  assert.deepEqual(sent, ["不受影响"])
  assert.equal(service.history().find(item => item.plugin === "bad-plugin")?.muted, true)
  service.unmute("plugin:bad-plugin")
  service.raise("deny", "z", "恢复推送", { key: "m3", plugin: "bad-plugin" })
  assert.equal(sent.at(-1), "恢复推送")
  service.mute({ category: "deny" }, 10)
  service.raise("deny", "w", "类别静默", { key: "m4" })
  assert.equal(sent.at(-1), "恢复推送")
  assert.equal(service.state().mutes.length, 1)
})

test("资源历史把累计值换算为速率，进程重建后不产生负值", () => {
  const history = new ResourceHistory()
  const base = {
    processes: 3,
    remote: ["1.1.1.1:443"],
    loopback: 1,
    rssBytes: 100,
  }
  history.push({ ...base, sampledAt: 1000, readBytes: 0, writeBytes: 0, cpuSeconds: 0 })
  history.push({ ...base, sampledAt: 11000, readBytes: 5000, writeBytes: 1000, cpuSeconds: 5 })
  history.push({ ...base, sampledAt: 21000, readBytes: 10, writeBytes: 0, cpuSeconds: 1 })
  const [first, second, third] = history.points()
  assert.equal(first.cpu, 0)
  assert.equal(second.cpu, 0.5)
  assert.equal(second.readBytesPerSecond, 500)
  assert.equal(second.connections, 2)
  assert.equal(third.cpu, 0)
  assert.equal(third.readBytesPerSecond, 0)
})

test("ps 的累计 CPU 时间可解析", () => {
  assert.equal(cpuTime("1:02.50"), 62.5)
  assert.equal(cpuTime("1-00:00:01"), 86401)
  assert.equal(cpuTime("bad"), 0)
})

test("审计对比找出新增、消失与明显变化的行为", async () => {
  const { compareAudit } = await import("../dist/web/compare.js")
  const entry = (time, target, action = "audit") => ({
    id: `${time}${target}`,
    time,
    kind: "network",
    operation: "fetch",
    target,
    action,
    plugin: "p",
  })
  const rows = [
    ...Array.from({ length: 2 }, (_, i) => entry(100 + i, "https://old.example")),
    ...Array.from({ length: 4 }, (_, i) => entry(110 + i, "https://same.example")),
    ...Array.from({ length: 12 }, (_, i) => entry(1100 + i, "https://same.example")),
    entry(1200, "https://new.example", "deny"),
  ]
  const read = params => {
    const from = Number(params.get("from"))
    const to = Number(params.get("to"))
    const items = rows.filter(row => row.time >= from && row.time <= to)
    return { items, hasMore: false }
  }
  const result = compareAudit(read, { a: { from: 0, to: 999 }, b: { from: 1000, to: 2000 } }, "p")
  assert.deepEqual([result.a.total, result.b.total, result.b.blocked], [6, 13, 1])
  assert.deepEqual(
    result.added.map(item => item.target),
    ["https://new.example"],
  )
  assert.deepEqual(
    result.removed.map(item => item.target),
    ["https://old.example"],
  )
  assert.deepEqual(
    result.changed.map(item => [item.a, item.b]),
    [[4, 12]],
  )
})
