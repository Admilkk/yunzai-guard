import assert from "node:assert/strict"
import test from "node:test"
import { parsePluginSandbox } from "../dist/plugin-sandbox/config.js"

const descriptor = (overrides = {}) => ({
  id: "echo",
  match: "#echo *",
  capabilities: ["reply"],
  ...overrides,
})

test("plugin sandbox remains opt-in and legacy settings preserve explicit grants", () => {
  assert.deepEqual(parsePluginSandbox(), {
    plugins: [],
    native: { plugins: [] },
    timeoutMs: 1000,
    memoryMiB: 16,
    violationAction: "deny",
    hookAction: "deny",
  })
  const legacy = {
    plugins: [descriptor({ capabilities: [] })],
    timeoutMs: 500,
    memoryMiB: 8,
    violationAction: "restart",
  }
  const normalized = parsePluginSandbox(undefined, legacy)
  assert.deepEqual(
    normalized,
    parsePluginSandbox({
      defaults: { timeoutMs: 500, memoryMiB: 8, violationAction: "restart" },
      plugins: [descriptor({ capabilities: [] })],
    }),
  )
  assert.deepEqual(normalized.plugins[0].capabilities, [])
  assert.equal(normalized.plugins[0].enabled, true)
  assert.throws(
    () => parsePluginSandbox({}, {}),
    /settings\.pluginSandbox 与 settings\.strictJs 不能同时配置/,
  )
  assert.throws(() => parsePluginSandbox(null), TypeError)
  assert.throws(() => parsePluginSandbox(undefined, null), TypeError)
})

test("each plugin resolves independent limits, hook policy, enablement and local rules", () => {
  const config = parsePluginSandbox({
    defaults: { timeoutMs: 900, memoryMiB: 12, violationAction: "restart", hookAction: "audit" },
    plugins: [
      descriptor({
        enabled: false,
        timeoutMs: 100,
        memoryMiB: 4,
        violationAction: "deny",
        hookAction: "deny",
        rules: [
          { id: "hook", kind: ["plugin-sandbox"], operation: "sandbox.hook", action: "deny" },
        ],
      }),
      descriptor({ id: "second", match: "#second *", capabilities: ["writeText"] }),
    ],
  })
  assert.deepEqual(config.plugins[0], {
    ...descriptor(),
    enabled: false,
    timeoutMs: 100,
    memoryMiB: 4,
    violationAction: "deny",
    hookAction: "deny",
    rules: [{ id: "hook", kind: ["plugin-sandbox"], operation: "sandbox.hook", action: "deny" }],
  })
  assert.deepEqual(config.plugins[1], {
    ...descriptor({ id: "second", match: "#second *", capabilities: ["writeText"] }),
    enabled: true,
    timeoutMs: 900,
    memoryMiB: 12,
    violationAction: "restart",
    hookAction: "audit",
    rules: [],
  })
})

test("configuration snapshots are deeply frozen without freezing caller-owned input", () => {
  const input = {
    plugins: [descriptor({ rules: [{ id: "one", kind: ["plugin-sandbox"], action: "deny" }] })],
  }
  const config = parsePluginSandbox(input)
  for (const item of [
    config,
    config.plugins,
    config.plugins[0],
    config.plugins[0].capabilities,
    config.plugins[0].rules,
    config.plugins[0].rules[0],
    config.plugins[0].rules[0].kind,
  ])
    assert.equal(Object.isFrozen(item), true)
  input.plugins[0].capabilities.push("writeText")
  input.plugins[0].rules[0].kind.push("network")
  assert.deepEqual(config.plugins[0].capabilities, ["reply"])
  assert.deepEqual(config.plugins[0].rules[0].kind, ["plugin-sandbox"])
  assert.throws(() => (config.plugins[0].enabled = false), TypeError)
  assert.deepEqual(parsePluginSandbox(JSON.parse(JSON.stringify(config))), config)
})

test("invalid local permissions, unknown keys and quota settings fail closed", () => {
  const invalidEntries = [
    { id: "CON" },
    { id: "con" },
    { id: "../other" },
    { match: "" },
    { capabilities: undefined },
    { capabilities: ["reply", "reply"] },
    { capabilities: ["exec"] },
    { enabled: "false" },
    { timeoutMs: 99 },
    { timeoutMs: 5001 },
    { memoryMiB: 3 },
    { memoryMiB: 65 },
    { violationAction: "audit" },
    { hookAction: "allow" },
    { mode: "native" },
    { rules: [{ id: "rule", action: "allow" }] },
    { rules: [{ id: "rule", action: "deny", expression: "process.exit()" }] },
    {
      rules: [
        { id: "rule", action: "deny" },
        { id: "rule", action: "audit" },
      ],
    },
    { rules: [{ id: "rule", action: "deny", kind: [] }] },
  ]
  for (const input of invalidEntries)
    assert.throws(() => parsePluginSandbox({ plugins: [descriptor(input)] }), TypeError)
  for (const input of [
    { defaults: { timeoutMs: 500 }, timeoutMs: 500 },
    { defaults: null },
    { defaults: { hookAction: "allow" } },
    { defaults: { violationAction: "audit" } },
    { plugins: [descriptor(), descriptor()] },
    { plugins: Array.from({ length: 17 }, (_, i) => descriptor({ id: `plugin-${i}` })) },
  ])
    assert.throws(() => parsePluginSandbox(input), TypeError)
  assert.throws(() => parsePluginSandbox(undefined, { plugins: [descriptor({ enabled: false })] }))
  assert.throws(() => parsePluginSandbox(undefined, { hookAction: "audit" }))
})

test("plain JSON validation rejects accessors without invoking them", () => {
  let invoked = false
  const input = { plugins: [descriptor()] }
  Object.defineProperty(input, "defaults", {
    enumerable: true,
    get() {
      invoked = true
      throw new Error("must not run")
    },
  })
  assert.throws(() => parsePluginSandbox(input), /settings\.pluginSandbox 只能包含普通 JSON 属性/)
  assert.equal(invoked, false)
  assert.throws(
    () => parsePluginSandbox(Object.create({ defaults: {} })),
    /settings\.pluginSandbox 须为普通 JSON 对象/,
  )
})
