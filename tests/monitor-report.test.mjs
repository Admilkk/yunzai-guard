import assert from "node:assert/strict"
import test from "node:test"
import { IntegrityMonitor } from "../dist/monitor/integrity.js"
import { parseSettings } from "../dist/config/index.js"
import { monitorStatus, parseMonitorReport } from "../dist/monitor/report.js"

test("coverage distinguishes missing, throwing, protected, changed and disabled targets", () => {
  const bot = { em() {} }
  Object.defineProperty(bot, "throwing", {
    configurable: true,
    get() {
      throw new Error("getter")
    },
  })
  const settings = parseSettings({
    protect: { targets: ["Bot.em", "Bot.missing", "Bot.throwing"] },
  })
  const monitor = new IntegrityMonitor(settings, { Bot: bot }, () => {})
  monitor.capture()
  assert.deepEqual(
    monitor.coverage().targets.map(row => row.state),
    ["protected", "pending", "inspection-failed"],
  )
  const original = bot.em
  bot.em = () => {}
  bot.missing = () => {}
  monitor.check()
  assert.deepEqual(
    monitor.coverage().targets.map(row => row.state),
    ["changed", "protected", "inspection-failed"],
  )
  bot.em = original
  monitor.check()
  assert.equal(monitor.coverage().targets[0].state, "protected")
  const disabled = new IntegrityMonitor(
    parseSettings({ protect: { enabled: false, targets: ["Bot.em"] } }),
    {},
    () => {},
  )
  assert.equal(disabled.coverage().targets[0].state, "disabled")
})

test("throwing root provider is reported without crashing periodic checking", () => {
  let fail = false
  const bot = { em() {} }
  const monitor = new IntegrityMonitor(
    parseSettings({ protect: { targets: ["Bot.em"] } }),
    () => {
      if (fail) throw new Error("roots")
      return { Bot: bot }
    },
    () => {},
  )
  monitor.capture()
  fail = true
  assert.doesNotThrow(() => monitor.check())
  assert.equal(monitor.coverage().targets[0].state, "inspection-failed")
  fail = false
  monitor.check()
  assert.equal(monitor.coverage().targets[0].state, "protected")
})

test("host validates bounded snapshots, strips extra data, and labels stale or absent reports", () => {
  const packet = {
    targets: [{ state: "pending", reason: "missing", secret: "discard" }],
    plugins: {
      entries: [
        {
          name: "business",
          imports: 1,
          loads: 1,
          registered: 1,
          calls: 2,
          blocked: 0,
          unwrapped: 0,
          secret: "discard",
        },
      ],
      truncated: false,
    },
  }
  const report = parseMonitorReport(packet, 1)
  assert.equal(JSON.stringify(report).includes("secret"), false)
  const snapshot = { report, receivedAt: 100 }
  assert.equal(monitorStatus(["Bot.em"], snapshot, true, 101).freshness, "current")
  assert.equal(monitorStatus(["Bot.em"], snapshot, true, 10101).freshness, "stale")
  assert.equal(monitorStatus(["Bot.em"], snapshot, false, 101).freshness, "stale")
  assert.equal(monitorStatus(["Bot.em"]).targets[0].state, "unreported")
  for (const bad of [
    null,
    { ...packet, targets: [] },
    { ...packet, targets: [{ state: "trust-me" }] },
    {
      ...packet,
      plugins: { entries: Array(129).fill(packet.plugins.entries[0]), truncated: false },
    },
  ])
    assert.throws(() => parseMonitorReport(bad, 1))
  for (const count of [-1, Infinity, NaN, 1.5, "1"])
    assert.throws(() =>
      parseMonitorReport(
        {
          ...packet,
          plugins: { ...packet.plugins, entries: [{ ...packet.plugins.entries[0], calls: count }] },
        },
        1,
      ),
    )
})
