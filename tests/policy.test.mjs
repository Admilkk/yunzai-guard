import assert from "node:assert/strict"
import test from "node:test"
import { parseSettings } from "../dist/config/index.js"
import { decide, matchGlob } from "../dist/config/policy.js"

test("no matching behavior rule audits instead of silently granting a broad exception", () => {
  const config = parseSettings({})
  assert.deepEqual(decide({ kind: "process", operation: "exec", target: "tool" }, config.rules), {
    action: "audit",
  })
  assert.equal(config.protect.action, "audit")
  assert.equal(config.isolationMode, "managed")
  assert.deepEqual(config.rules, [])
  assert.deepEqual(config.pluginSandbox.native.plugins, [])
  assert.deepEqual(config.pluginSandbox.plugins, [])
  for (const target of [
    "Bot.serverAuth",
    "Bot.sendGroupMsg",
    "PluginsLoader.importPlugin",
    "PluginsLoader.dealEvent",
    "PluginsLoader.collectTask",
    "Global.plugin.prototype.reply",
    "PluginsLoader.unloadPlugin",
  ])
    assert.ok(config.protect.targets.includes(target), target)
  for (const target of ["Bot.em", "Bot.prepareEvent", "Bot.emit", "Global.process.emit"])
    assert.equal(config.protect.targets.includes(target), false, target)
  assert.deepEqual(parseSettings({ protect: { targets: ["Bot.em"] } }).protect.targets, ["Bot.em"])
  assert.deepEqual(parseSettings({ protect: { targets: [] } }).protect.targets, [])
})

test("narrow plugin exception precedes a broad network violation rule", () => {
  const config = parseSettings({
    rules: [
      {
        id: "allowed-endpoint",
        kind: "network",
        plugin: "trusted",
        target: "https://api.example.test/*",
        action: "audit",
      },
      { id: "network-policy", kind: "network", action: "restart" },
    ],
  })
  const event = {
    kind: "network",
    operation: "fetch",
    target: "https://api.example.test/data",
    plugin: "trusted",
  }
  assert.deepEqual(decide(event, config.rules), { action: "audit", ruleId: "allowed-endpoint" })
  assert.deepEqual(decide({ ...event, target: "https://other.example.test/data" }, config.rules), {
    action: "restart",
    ruleId: "network-policy",
  })
  assert.deepEqual(decide({ ...event, plugin: "untrusted" }, config.rules), {
    action: "restart",
    ruleId: "network-policy",
  })
})

test("unknown attribution is explicit and kind arrays never match unrelated actions", () => {
  const config = parseSettings({
    rules: [
      { id: "unknown-execution", kind: ["process", "worker"], plugin: "unknown", action: "deny" },
    ],
  })
  assert.equal(
    decide({ kind: "process", operation: "spawn", target: "tool" }, config.rules).action,
    "deny",
  )
  assert.equal(
    decide({ kind: "network", operation: "fetch", target: "tool" }, config.rules).action,
    "audit",
  )
})

test("glob treats regular expression metacharacters as literal text", () => {
  assert.equal(matchGlob("*.example.test:443", "api.example.test:443"), true)
  assert.equal(matchGlob("*.example.test:443", "api.exampleXtest:443"), false)
  assert.equal(matchGlob("tool[1]?", "tool[1]x"), true)
  assert.equal(matchGlob("tool[1]?", "tool1x"), false)
  assert.equal(matchGlob("*a*b", "xxaaxxb"), true)
})

test("invalid security configuration fails visibly rather than falling back to defaults", () => {
  for (const input of [
    { protect: { enabled: "false" } },
    { rules: [{ id: "typo", action: "resart" }] },
    { recovery: { maxRestarts: -1 } },
    { recovery: { baseDelayMs: 200, maxDelayMs: 100 } },
    { controlPort: 1 },
    { protect: { targets: ["Bot.em", "Bot.em"] } },
    {
      rules: [
        { id: "same", action: "audit" },
        { id: "same", action: "deny" },
      ],
    },
    { rules: [{ id: "unsafe-expression", action: "deny", when: "process.exit()" }] },
    { unknownSetting: true },
    { schemaVersion: 2 },
  ])
    assert.throws(() => parseSettings(input), TypeError)
})
