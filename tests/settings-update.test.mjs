import assert from "node:assert/strict"
import test from "node:test"
import { parseSettings, snapshotSettings } from "../dist/config/index.js"
import { planSettingsUpdate } from "../dist/config/update.js"

test("automatic control port normalizes to omission and reserved explicit ports remain invalid", () => {
  assert.deepEqual(parseSettings({ controlPort: 0 }), parseSettings({}))
  assert.equal(Object.hasOwn(parseSettings({ controlPort: 0 }), "controlPort"), false)
  for (const controlPort of [-1, 1, 1023, 65536, "0", null])
    assert.throws(() => parseSettings({ controlPort }), /settings.controlPort/)
  assert.equal(parseSettings({ controlPort: 1024 }).controlPort, 1024)
})

test("a mixed update isolates live limits, generation policies and the host listener", () => {
  const active = parseSettings({ controlPort: 21733 })
  const next = parseSettings({
    ...active,
    controlPort: 21734,
    recovery: { ...active.recovery, maxRestarts: 5 },
    audit: { maxEventsPerSecond: 200, maxBytes: 2048, maxFiles: 2, maxQueue: 2000 },
    protect: { ...active.protect, action: "deny" },
    rules: [{ id: "custom", plugin: "demo", action: "deny" }],
  })
  const plan = planSettingsUpdate(active, next)
  assert.deepEqual(plan.liveFields, [
    "recovery",
    "audit.maxEventsPerSecond",
    "audit.maxBytes",
    "audit.maxFiles",
  ])
  assert.deepEqual(plan.reloadFields, ["rules", "protect", "audit.maxQueue"])
  assert.deepEqual(plan.restartFields, ["controlPort"])
  assert.equal(plan.live.recovery.maxRestarts, 5)
  assert.equal(plan.live.audit.maxEventsPerSecond, 200)
  assert.equal(plan.live.audit.maxQueue, active.audit.maxQueue)
  assert.deepEqual(plan.live.rules, [])
  assert.equal(plan.live.protect.action, "audit")
  assert.equal(plan.candidate.controlPort, 21733)
  assert.equal(plan.candidate.rules[0].action, "deny")
  assert.equal(plan.candidate.audit.maxQueue, 2000)
  assert.deepEqual(snapshotSettings(plan.candidate), plan.candidate)
  assert.throws(() => (plan.live.audit.maxBytes = 10000), TypeError)
  assert.equal(active.recovery.maxRestarts, 3)
  assert.equal(next.controlPort, 21734)
})

test("equivalent normalized settings do not cause a reload and defaults remain observational", () => {
  const active = parseSettings({})
  const reordered = { controlPort: 0, ...Object.fromEntries(Object.entries(active).reverse()) }
  const plan = planSettingsUpdate(active, reordered)
  assert.deepEqual(plan.liveFields, [])
  assert.deepEqual(plan.reloadFields, [])
  assert.deepEqual(plan.restartFields, [])
  assert.equal(plan.candidate.isolationMode, "managed")
  assert.equal(plan.candidate.protect.action, "audit")
  assert.deepEqual(plan.candidate.rules, [])
  assert.deepEqual(plan.candidate.pluginSandbox.plugins, [])
  assert.deepEqual(plan.candidate.pluginSandbox.native.plugins, [])
})

test("sandbox and launch changes stay pending for a coordinated generation replacement", () => {
  const active = parseSettings({})
  const next = parseSettings({
    ...active,
    isolationMode: "os-sandbox",
    sandbox: { ...active.sandbox, network: "host" },
    pluginSandbox: {
      native: { plugins: [{ id: "demo", enabled: false, hookAction: "audit" }] },
    },
    startupTimeout: 61000,
    shutdownTimeout: 11000,
    handshakeTimeout: 6000,
  })
  const plan = planSettingsUpdate(active, next)
  assert.deepEqual(plan.reloadFields, [
    "pluginSandbox",
    "isolationMode",
    "sandbox",
    "startupTimeout",
    "shutdownTimeout",
    "handshakeTimeout",
  ])
  assert.deepEqual(plan.live, active)
  assert.deepEqual(plan.candidate, next)
})
