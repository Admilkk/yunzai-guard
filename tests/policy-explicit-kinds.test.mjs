import assert from "node:assert/strict"
import test from "node:test"
import { decide, isExplicitKind, kindMatches } from "../dist/config/policy.js"
import { runtimeEventDecision } from "../dist/runtime/policy.js"
import { parseSettings } from "../dist/config/index.js"

const event = kind => ({ kind, operation: "op", target: "t", plugin: "demo" })

test("explicit kinds only match a literal kind entry", () => {
  for (const kind of ["filesystem", "native", "listen"]) {
    assert.equal(isExplicitKind(kind), true)
    assert.equal(kindMatches(undefined, kind), false)
    assert.equal(kindMatches("*", kind), false)
    assert.equal(kindMatches(["network", "*"], kind), false)
    assert.equal(kindMatches("file*", kind), false)
    assert.equal(kindMatches(kind, kind), true)
    assert.equal(kindMatches(["network", kind], kind), true)
  }
  assert.equal(isExplicitKind("network"), false)
  assert.equal(kindMatches(undefined, "network"), true)
  assert.equal(kindMatches("net*", "network"), true)
})

test("broad legacy rules keep their pre-1.0 reach", () => {
  const rules = [{ id: "broad", plugin: "demo", action: "deny" }]
  assert.deepEqual(decide(event("network"), rules), { action: "deny", ruleId: "broad" })
  assert.deepEqual(decide(event("process"), rules), { action: "deny", ruleId: "broad" })
  for (const kind of ["filesystem", "native", "listen"])
    assert.deepEqual(decide(event(kind), rules), { action: "audit" })
})

test("host recomputation applies the same explicit-kind rule", () => {
  const settings = parseSettings({
    rules: [{ id: "files", kind: "filesystem", plugin: "demo", action: "restart" }],
  })
  const reported = { ...event("filesystem"), action: "restart", ruleId: "files" }
  assert.deepEqual(runtimeEventDecision(settings, reported), {
    action: "restart",
    ruleId: "files",
  })
  const broad = parseSettings({ rules: [{ id: "all", kind: "*", action: "restart" }] })
  const spoofed = { ...event("native"), action: "restart", ruleId: "all" }
  assert.deepEqual(runtimeEventDecision(broad, spoofed), { action: "audit" })
})
