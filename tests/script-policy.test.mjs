import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import ts from "typescript"
import { parseSettings } from "../dist/config/index.js"
import { decide, defaultPolicyDecision } from "../dist/config/policy.js"
import { samplePolicyDecision } from "../dist/config/sample-policy.js"
import { runtimeEventDecision } from "../dist/runtime/policy.js"
import { authorizeHostEvent } from "../dist/host/event-policy.js"

const script = {
  kind: "process",
  operation: "spawn",
  target: "node",
  plugin: "example",
  details: { scriptExecution: true, argumentsRedacted: true, blocked: true },
}

const compiledRules = ts
  .transpileModule(fs.readFileSync(new URL("../web/src/lib/rules.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  })
  .outputText.replaceAll(
    "../../../src/config/policy.js",
    new URL("../dist/config/policy.js", import.meta.url).href,
  )
  .replaceAll(
    "../../../src/config/sample-policy.js",
    new URL("../dist/config/sample-policy.js", import.meta.url).href,
  )
const { sampleDecision } = await import(
  "data:text/javascript;base64," + Buffer.from(compiledRules).toString("base64")
)

test("script and process creation default to audit in runtime and host policy", () => {
  const settings = parseSettings({})
  for (const operation of [
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "spawn",
    "spawnSync",
    "fork",
  ]) {
    const event = { ...script, operation, action: "audit", ruleId: "invented" }
    assert.deepEqual(defaultPolicyDecision(event), { action: "audit" })
    assert.deepEqual(decide(event, []), { action: "audit" })
    assert.deepEqual(samplePolicyDecision(event, []), { action: "audit", uncertain: false })
    assert.deepEqual(runtimeEventDecision(settings, event), { action: "audit" })
    const actual = authorizeHostEvent(settings, event)
    assert.equal(actual.action, "audit")
    assert.equal(actual.ruleId, undefined)
  }
})

test("ordinary commands and non-boolean script claims keep the default audit action", () => {
  const settings = parseSettings({})
  for (const scriptExecution of [undefined, false, "true", 1]) {
    const event = {
      ...script,
      action: "restart",
      details: { scriptExecution, argumentsRedacted: true },
    }
    assert.deepEqual(runtimeEventDecision(settings, event), { action: "audit" })
    assert.deepEqual(decide(event, []), { action: "audit" })
    assert.deepEqual(samplePolicyDecision(event, []), { action: "audit", uncertain: false })
    assert.equal(authorizeHostEvent(settings, event).action, "audit")
  }
})

test("script defaults preserve explicit rules and never trust the reported action", () => {
  for (const action of ["audit", "deny", "restart"]) {
    const settings = parseSettings({
      rules: [{ id: "selected", kind: "process", plugin: "example", action }],
    })
    const event = { ...script, action: "audit", ruleId: "invented" }
    assert.deepEqual(decide(event, settings.rules), { action, ruleId: "selected" })
    assert.deepEqual(samplePolicyDecision(event, settings.rules), {
      action,
      ruleId: "selected",
      uncertain: false,
    })
    assert.deepEqual(runtimeEventDecision(settings, event), { action, ruleId: "selected" })
    const actual = authorizeHostEvent(settings, event)
    assert.equal(actual.action, action)
    assert.equal(actual.ruleId, "selected")
  }
  const settings = parseSettings({
    rules: [{ id: "deny-command", kind: "process", action: "deny" }],
  })
  assert.equal(
    authorizeHostEvent(settings, {
      ...script,
      action: "audit",
      details: { scriptExecution: false },
    }).action,
    "deny",
  )
  assert.equal(
    authorizeHostEvent(parseSettings({ rules: [{ id: "observe", action: "audit" }] }), {
      ...script,
      kind: "self-protection",
      action: "audit",
    }).action,
    "deny",
  )
})

test("script claims do not change other event kinds or Worker policy", () => {
  const settings = parseSettings({})
  for (const change of [
    { kind: "network", operation: "fetch" },
    { kind: "runtime", operation: "external-runtime-unobservable" },
    { kind: "process", operation: "worker" },
    { kind: "process", operation: "kill" },
  ]) {
    const event = { ...script, ...change, action: "restart" }
    assert.deepEqual(runtimeEventDecision(settings, event), { action: "audit" })
    assert.equal(authorizeHostEvent(settings, event).action, "audit")
  }
})

test("host script evidence cannot revive an unverified redacted shell rule", () => {
  const settings = parseSettings({
    rules: [
      {
        id: "allow-script",
        kind: "process",
        operation: "exec",
        target: "node safe.js",
        action: "audit",
      },
    ],
  })
  const actual = authorizeHostEvent(settings, {
    ...script,
    operation: "exec",
    action: "audit",
    ruleId: "allow-script",
  })
  assert.equal(actual.action, "audit")
  assert.equal(actual.ruleId, undefined)
})

test("UI script samples share default and explicit policy while ignoring non-boolean claims", () => {
  const entry = { ...script, id: "script-1", time: 1, type: "audit", action: "deny" }
  assert.deepEqual(sampleDecision(entry, []), { action: "audit", uncertain: false })
  const stored = { ...entry, details: { event: { ...script } } }
  assert.deepEqual(sampleDecision(stored, []), { action: "audit", uncertain: false })
  assert.deepEqual(
    sampleDecision(entry, [{ id: "allow-node", kind: "process", target: "node", action: "audit" }]),
    { action: "audit", ruleId: "allow-node", uncertain: false },
  )
  assert.deepEqual(sampleDecision({ ...entry, details: { scriptExecution: "true" } }, []), {
    action: "audit",
    uncertain: false,
  })
})
