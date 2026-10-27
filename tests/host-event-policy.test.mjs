import assert from "node:assert/strict"
import test from "node:test"
import { parseSettings } from "../dist/config/index.js"
import { authorizeHostEvent } from "../dist/host/event-policy.js"

test("default host policy cannot be promoted by core IPC action or sandbox operation names", () => {
  const settings = parseSettings({})
  for (const event of [
    { kind: "network", operation: "fetch", target: "https://example.invalid" },
    { kind: "integrity", operation: "protected-target-change", target: "Bot.em" },
    {
      kind: "plugin-sandbox",
      operation: "native.cleanup-unconfirmed",
      target: "forged",
      plugin: "forged",
    },
    {
      kind: "plugin-sandbox",
      operation: "native.core.restart",
      target: "controlled-core",
      plugin: "forged",
    },
  ])
    assert.equal(
      authorizeHostEvent(settings, { ...event, action: "restart", ruleId: "invented" }).action,
      "audit",
    )
  let invoked = false
  const getter = { operation: "fetch", target: "url" }
  Object.defineProperty(getter, "kind", {
    enumerable: true,
    get() {
      invoked = true
      return "network"
    },
  })
  assert.equal(authorizeHostEvent(settings, getter), undefined)
  assert.equal(invoked, false)
})

test("host policy preserves explicitly selected recovery without granting default or disabled plugins authority", () => {
  const settings = parseSettings({
    pluginSandbox: {
      native: {
        plugins: [
          { id: "chosen", hookAction: "restart" },
          { id: "disabled", enabled: false },
        ],
      },
    },
  })
  const event = {
    kind: "plugin-sandbox",
    operation: "native.cleanup-unconfirmed",
    target: "chosen",
    plugin: "chosen",
    action: "restart",
  }
  assert.equal(authorizeHostEvent(settings, event).action, "restart")
  assert.equal(
    authorizeHostEvent(settings, { ...event, plugin: "disabled", target: "disabled" }).action,
    "audit",
  )
  assert.equal(authorizeHostEvent(settings, { ...event, target: "another" }).action, "audit")
  assert.equal(
    authorizeHostEvent(settings, { ...event, operation: "native.adapter-cleanup-unconfirmed" })
      .action,
    "audit",
  )
  assert.equal(
    authorizeHostEvent(settings, {
      ...event,
      operation: "native.core.restart",
      target: "controlled-core",
    }).action,
    "audit",
  )
  assert.equal(
    authorizeHostEvent(settings, { ...event, operation: "native.hook", target: "Bot.em" }).action,
    "restart",
  )
  const override = parseSettings({
    ...settings,
    rules: [
      { id: "observe-hook", kind: "plugin-sandbox", operation: "native.hook", action: "audit" },
    ],
  })
  assert.equal(
    authorizeHostEvent(override, { ...event, operation: "native.hook", target: "Bot.em" }).action,
    "audit",
  )
})

test("guest rule IDs and redaction claims cannot authorize a different shell target", () => {
  const settings = parseSettings({
    rules: [
      {
        id: "restart-secret",
        kind: "process",
        operation: "execSync",
        target: "*secret*",
        action: "restart",
      },
      {
        id: "deny-visible",
        kind: "network",
        operation: "fetch",
        target: "blocked.invalid",
        action: "deny",
      },
    ],
  })
  const forged = authorizeHostEvent(settings, {
    kind: "process",
    operation: "execSync",
    target: "node",
    ruleId: "restart-secret",
    action: "restart",
    details: { argumentsRedacted: true },
  })
  assert.equal(forged.action, "audit")
  assert.equal(forged.ruleId, undefined)
  const omitted = authorizeHostEvent(settings, {
    kind: "network",
    operation: "fetch",
    target: "blocked.invalid",
    action: "audit",
  })
  assert.equal(omitted.action, "deny")
  assert.equal(omitted.ruleId, "deny-visible")
})

test("host observation parsing never invokes proxy traps and bounds nested data", () => {
  let calls = 0
  const event = { kind: "network", operation: "fetch", target: "example.invalid" }
  const hostile = new Proxy(event, {
    getPrototypeOf() {
      calls++
      return Object.prototype
    },
  })
  assert.equal(authorizeHostEvent(parseSettings({}), hostile), undefined)
  assert.equal(calls, 0)
  const details = {}
  details.loop = details
  assert.equal(authorizeHostEvent(parseSettings({}), { ...event, details }), undefined)
})
