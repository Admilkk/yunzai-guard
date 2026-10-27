import assert from "node:assert/strict"
import test from "node:test"
import { parseSettings } from "../dist/config/index.js"
import { validateNativeBehaviorEvent } from "../dist/native-sandbox/behavior-host.js"
import { toDto } from "../dist/native-sandbox/guest.js"

const settings = parseSettings({
  protect: { action: "restart" },
  rules: [
    {
      id: "blocked-exec",
      plugin: "Business",
      kind: "process",
      operation: "exec*",
      target: "*private-argument*",
      action: "restart",
    },
  ],
})
const report = {
  kind: "process",
  operation: "execSync",
  target: "node",
  plugin: "forged-host-plugin",
  action: "restart",
  ruleId: "blocked-exec",
  timestamp: "forged",
  details: {
    blocked: true,
    arguments: ["private-argument"],
    token: "not-forwarded",
    runtime: { id: "guest-thread", kind: "thread", pid: 999999, threadId: 2 },
  },
}

test("native behavior reports bind host identity and forward only redacted guest evidence", () => {
  const event = validateNativeBehaviorEvent(settings, "Business", report)
  assert.equal(event.plugin, "Business")
  assert.equal(event.action, "audit")
  assert.equal(event.ruleId, undefined)
  assert.notEqual(event.timestamp, "forged")
  assert.deepEqual(event.details, {
    source: "guest-reported",
    observability: "js-entrypoints",
    argumentsRedacted: true,
    reportedBlocked: true,
    guestRuntime: { id: "guest-thread", kind: "thread", threadId: 2 },
  })
  assert.equal(JSON.stringify(event).includes("private-argument"), false)
  assert.equal(
    event.details.runtime,
    undefined,
    "Guest PID claims cannot enter trusted runtime state",
  )
})

test("reported decisions cannot invent actions, use another plugin's rule or change its scope", () => {
  for (const [pluginId, changes] of [
    ["Other", {}],
    ["Business", { kind: "network" }],
    ["Business", { operation: "spawn" }],
    ["Business", { action: "deny" }],
    ["Business", { ruleId: "missing" }],
    ["Business", { ruleId: undefined }],
  ])
    assert.equal(
      validateNativeBehaviorEvent(settings, pluginId, { ...report, ...changes }).action,
      "audit",
    )
  assert.equal(
    validateNativeBehaviorEvent(settings, "Business", {
      kind: "network",
      operation: "fetch",
      target: "example.invalid:443",
      action: "audit",
    }).action,
    "audit",
  )
})

test("only configured instrumentation and known Worker bootstrap failures have non-rule fallback actions", () => {
  const event = {
    kind: "integrity",
    operation: "instrumentation-change",
    target: "child_process.exec",
    action: "restart",
  }
  assert.equal(validateNativeBehaviorEvent(settings, "Business", event).action, "restart")
  assert.equal(
    validateNativeBehaviorEvent(parseSettings({ protect: { enabled: false } }), "Business", event)
      .action,
    "audit",
  )
  assert.equal(
    validateNativeBehaviorEvent(settings, "Business", {
      ...event,
      kind: "runtime",
      operation: "runtime-bootstrap-failed",
    }).action,
    "restart",
  )
  assert.equal(
    validateNativeBehaviorEvent(settings, "Business", {
      ...event,
      kind: "runtime",
      operation: "unknown-failure",
    }).action,
    "audit",
  )
  assert.equal(
    validateNativeBehaviorEvent(settings, "Business", { ...event, operation: "unknown-change" })
      .action,
    "audit",
  )
})

test("default native behavior bootstrap failure stays audit while configured enforcement stays fail closed", () => {
  const event = {
    kind: "runtime",
    operation: "runtime-bootstrap-failed",
    target: "worker",
    action: "audit",
  }
  assert.equal(validateNativeBehaviorEvent(parseSettings({}), "Business", event).action, "audit")
  assert.equal(
    validateNativeBehaviorEvent(parseSettings({}), "Business", { ...event, action: "restart" })
      .action,
    "audit",
  )
  const scoped = parseSettings({
    rules: [{ id: "explicit-deny", plugin: "Business", kind: "process", action: "deny" }],
  })
  assert.equal(
    validateNativeBehaviorEvent(scoped, "Business", { ...event, action: "deny" }).action,
    "deny",
  )
  assert.equal(validateNativeBehaviorEvent(scoped, "Peer", event).action, "audit")
})

test("native reports cannot select a later restart rule over an earlier global audit", () => {
  const settings = parseSettings({
    rules: [
      { id: "observe-first", kind: "process", operation: "execSync", target: "*", action: "audit" },
      {
        id: "later-restart",
        kind: "process",
        operation: "execSync",
        target: "forbidden-command*",
        action: "restart",
      },
    ],
  })
  const event = validateNativeBehaviorEvent(settings, "Business", {
    kind: "process",
    operation: "execSync",
    target: "harmless",
    action: "restart",
    ruleId: "later-restart",
    details: { blocked: true },
  })
  assert.equal(event.action, "audit")
  assert.equal(event.ruleId, "observe-first")
})

test("the actual shared-runtime installation notification is accepted without broadening guard authority", () => {
  const event = {
    kind: "guard",
    operation: "instrumentation-installed",
    target: "builtin-js-entrypoints",
  }
  assert.equal(validateNativeBehaviorEvent(settings, "Business", event).action, "audit")
  assert.throws(() =>
    validateNativeBehaviorEvent(settings, "Business", { ...event, operation: "host-control" }),
  )
  assert.equal(
    validateNativeBehaviorEvent(settings, "Business", { ...event, action: "restart" }).action,
    "audit",
  )
})

test("behavior validation never evaluates accessors or arbitrary coercion", () => {
  let called = false
  const input = {
    ...report,
    get target() {
      called = true
      return "not-run"
    },
  }
  assert.throws(() => validateNativeBehaviorEvent(settings, "Business", input))
  assert.throws(() =>
    validateNativeBehaviorEvent(settings, "Business", {
      ...report,
      action: {
        toString() {
          called = true
          return "restart"
        },
      },
    }),
  )
  assert.throws(() =>
    validateNativeBehaviorEvent(settings, "Business", {
      ...report,
      details: {
        get runtime() {
          called = true
          return {}
        },
      },
    }),
  )
  assert.equal(called, false)
})

test("normal Worker audit survives the native DTO optional-field roundtrip without acquiring authority", () => {
  const event = toDto({
    kind: "process",
    operation: "fork",
    target: "application.mjs",
    action: "audit",
    ruleId: undefined,
    timestamp: undefined,
    details: { runtime: { id: "worker", kind: "thread", threadId: 1 } },
  })
  assert.equal(event.ruleId, null, "fixture must exercise the actual native wire representation")
  assert.equal(validateNativeBehaviorEvent(settings, "Business", event).action, "audit")
  assert.equal(
    validateNativeBehaviorEvent(settings, "Business", { ...event, action: "restart" }).action,
    "audit",
  )
  assert.throws(() => validateNativeBehaviorEvent(settings, "Business", { ...event, ruleId: 123 }))
})

test("native session identity and current rules override missing or forged guest authorization", () => {
  const settings = parseSettings({
    rules: [
      { id: "block-own-network", plugin: "Business", kind: "network", action: "deny" },
      { id: "observe-self", kind: "self-protection", action: "audit" },
    ],
  })
  const event = {
    kind: "network",
    operation: "fetch",
    target: "example.invalid",
    plugin: "Peer",
    action: "audit",
  }
  for (const ruleId of [undefined, null, "missing", "observe-self"]) {
    const result = validateNativeBehaviorEvent(settings, "Business", { ...event, ruleId })
    assert.equal(result.plugin, "Business")
    assert.equal(result.action, "deny")
    assert.equal(result.ruleId, "block-own-network")
  }
  assert.equal(validateNativeBehaviorEvent(settings, "Peer", event).action, "audit")
  const protection = validateNativeBehaviorEvent(settings, "Business", {
    kind: "self-protection",
    operation: "function-change",
    target: "http.get",
    action: "audit",
    ruleId: "observe-self",
  })
  assert.equal(protection.action, "deny")
  assert.equal(protection.ruleId, undefined)
})
