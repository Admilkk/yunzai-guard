import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { parseSettings } from "../dist/config/index.js"
import { SandboxDispatcher } from "../dist/plugin-sandbox/dispatcher.js"
import { SandboxExecutor } from "../dist/plugin-sandbox/executor.js"
import { loadSandboxSources } from "../dist/plugin-sandbox/filesystem.js"
import { sandboxDecision } from "../dist/plugin-sandbox/policy.js"

test("sandbox supports basic CommonJS plugin classes without handing over the real plugin base", async t => {
  const root = temporary(t)
  const config = settings([plugin("class-demo", { match: "#class" })])
  const f = dispatcher(t, root, config, {
    "class-demo": `module.exports = class extends plugin {
    constructor() { super({rule:[{reg:"^#class$",fnc:"hello"}]}) }
    hello(e) { this.reply(e.msg + ":class") }
  }`,
  })
  await f.dispatch("#class")
  assert.deepEqual(f.replies, ["#class:class"])
})

function plugin(id, extra = {}) {
  return { id, match: `#${id}`, capabilities: ["reply", "writeText"], ...extra }
}

function settings(plugins, extra = {}) {
  return parseSettings({
    ...extra,
    pluginSandbox: { defaults: { timeoutMs: 1000, memoryMiB: 16 }, plugins },
  })
}

function sources(config, programs) {
  return config.pluginSandbox.plugins.map(entry => ({
    ...entry,
    source: programs[entry.id] ?? "onMessage=()=>{}",
    sha256: "test",
  }))
}

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-plugin-sandbox-"))
  t.after(() => {
    const absolute = path.resolve(root)
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()))
    assert.ok(path.basename(absolute).startsWith("guard-plugin-sandbox-"))
    fs.rmSync(absolute, { recursive: true, force: true })
  })
  return root
}

function dispatcher(t, root, config, programs) {
  const events = [],
    replies = []
  const instance = new SandboxDispatcher(
    root,
    config,
    sources(config, programs),
    event => events.push(event),
    () => {},
  )
  t.after(() => instance.close())
  return {
    instance,
    events,
    replies,
    dispatch: msg => instance.dispatch({ msg, reply: text => replies.push(text) }),
  }
}

test("legacy settings normalize to plugin sandbox without granting additional capabilities", () => {
  const old = parseSettings({
    strictJs: { timeoutMs: 1000, memoryMiB: 16, plugins: [plugin("echo", { capabilities: [] })] },
  })
  assert.deepEqual(
    old.pluginSandbox,
    settings([plugin("echo", { capabilities: [] })]).pluginSandbox,
  )
  assert.deepEqual(parseSettings({}).pluginSandbox.plugins, [])
  assert.throws(() => parseSettings({ strictJs: {}, pluginSandbox: {} }))
  assert.deepEqual(parseSettings(JSON.parse(JSON.stringify(old))).pluginSandbox, old.pluginSandbox)
})

test("legacy rule aliases retain precedence over plugin-local rules with new event names", () => {
  const config = settings(
    [
      plugin("echo", {
        rules: [{ id: "local-allow", operation: "sandbox.reply", action: "audit" }],
      }),
    ],
    {
      rules: [{ id: "legacy-deny", kind: "strict-js", operation: "strict.reply", action: "deny" }],
    },
  )
  assert.deepEqual(
    sandboxDecision(config, config.pluginSandbox.plugins[0], {
      kind: "plugin-sandbox",
      plugin: "echo",
      operation: "sandbox.reply",
      target: "message",
    }),
    { action: "deny", ruleId: "legacy-deny" },
  )
})

test("per-plugin hook policies never change the real host and decide subsequent request commitment", async t => {
  const root = temporary(t)
  const hostBot = { em: () => "host" }
  const original = Object.getOwnPropertyDescriptor(globalThis, "Bot")
  Object.defineProperty(globalThis, "Bot", { configurable: true, value: hostBot })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "Bot", original)
    else delete globalThis.Bot
  })
  const config = settings(["audit", "deny", "restart"].map(id => plugin(id, { hookAction: id })))
  const programs = Object.fromEntries(
    config.pluginSandbox.plugins.map(({ id }) => [
      id,
      'onMessage=()=>{guard.writeText("before.txt","requested");try{Bot.em=()=>"changed"}catch{};guard.reply("safe")}',
    ]),
  )
  const run = dispatcher(t, root, config, programs)
  for (const id of ["audit", "deny", "restart"]) {
    await run.dispatch(`#${id}`)
    assert.equal(hostBot.em(), "host")
    const hooks = run.events.filter(
      event => event.plugin === id && event.operation === "sandbox.hook",
    )
    assert.ok(hooks.length > 0, `${id} must report the hook attempt`)
    assert.ok(
      hooks.some(event => event.action === id),
      `${id} must use the plugin policy`,
    )
    assert.equal(
      fs.existsSync(path.join(root, `data/yunzai-guard-strict/${id}/before.txt`)),
      id === "audit",
    )
  }
  assert.deepEqual(run.replies, ["safe"])
})

test("global restrictions precede local rules and plugin-local restrictions do not affect peers", async t => {
  const root = temporary(t)
  const config = settings(
    [
      plugin("global", {
        rules: [{ id: "local-allow", operation: "sandbox.reply", action: "audit" }],
      }),
      plugin("local", {
        rules: [{ id: "local-deny", operation: "sandbox.writeText", action: "deny" }],
      }),
      plugin("peer"),
    ],
    {
      rules: [{ id: "global-deny", plugin: "global", operation: "sandbox.reply", action: "deny" }],
    },
  )
  const program = 'onMessage=()=>{guard.writeText("state.txt","owned");guard.reply("allowed")}'
  const run = dispatcher(t, root, config, { global: program, local: program, peer: program })
  for (const id of ["global", "local", "peer"]) await run.dispatch(`#${id}`)
  assert.deepEqual(run.replies, ["allowed"])
  assert.equal(fs.existsSync(path.join(root, "data/yunzai-guard-strict/global/state.txt")), false)
  assert.equal(fs.existsSync(path.join(root, "data/yunzai-guard-strict/local/state.txt")), false)
  assert.equal(
    fs.readFileSync(path.join(root, "data/yunzai-guard-strict/peer/state.txt"), "utf8"),
    "owned",
  )
  assert.ok(run.events.some(event => event.ruleId === "global-deny" && event.action === "deny"))
  assert.ok(run.events.some(event => event.ruleId === "local-deny" && event.action === "deny"))
})

test("each invocation receives a fresh VM with no shared global or prototype state", async t => {
  const config = settings([plugin("first"), plugin("second")])
  const programs = sources(config, {
    first:
      'onMessage=()=>{globalThis.sharedSecret="private";Array.prototype.polluted="private";guard.reply("first")}',
    second: 'onMessage=()=>guard.reply(typeof sharedSecret+":"+typeof [].polluted)',
  })
  const executor = new SandboxExecutor()
  t.after(() => executor.close())
  const event = { message: "", userId: "", groupId: "", selfId: "", isGroup: false }
  const first = await executor.execute(programs[0], event, config.pluginSandbox)
  assert.equal(first.ok, true)
  const second = await executor.execute(programs[1], event, config.pluginSandbox)
  assert.equal(second.ok, true)
  assert.equal(second.actions[0].text, "undefined:undefined")
  assert.equal(Array.prototype.polluted, undefined)
  assert.equal(globalThis.sharedSecret, undefined)
  const repeat = await executor.execute(
    { ...programs[0], source: programs[1].source },
    event,
    config.pluginSandbox,
  )
  assert.equal(repeat.ok, true)
  assert.equal(repeat.actions[0].text, "undefined:undefined")
})

test("same file names belong to separate plugin directories and cross-plugin writes do not commit", async t => {
  const root = temporary(t)
  const config = settings([plugin("first"), plugin("second"), plugin("attacker")])
  const run = dispatcher(t, root, config, {
    first: 'onMessage=()=>guard.writeText("state.txt","first")',
    second: 'onMessage=()=>guard.writeText("state.txt","second")',
    attacker:
      'onMessage=()=>{try{guard.writeText("../first/state.txt","changed")}catch{};guard.writeText("state.txt","must-not-commit")}',
  })
  for (const id of ["first", "second", "attacker"]) await run.dispatch(`#${id}`)
  for (const id of ["first", "second"])
    assert.equal(
      fs.readFileSync(path.join(root, `data/yunzai-guard-strict/${id}/state.txt`), "utf8"),
      id,
    )
  assert.equal(fs.existsSync(path.join(root, "data/yunzai-guard-strict/attacker/state.txt")), false)
})

test("ordinary concurrency rejection is audited without triggering the plugin restart policy", async t => {
  const root = temporary(t)
  const config = settings([plugin("busy", { violationAction: "restart" })])
  const run = dispatcher(t, root, config, { busy: "onMessage=()=>new Promise(()=>{})" })
  const first = run.dispatch("#busy")
  assert.equal(await run.dispatch("#busy"), true)
  assert.ok(
    run.events.some(event => event.operation === "sandbox.admission" && event.action === "audit"),
  )
  assert.equal(
    run.events.some(event => event.action === "restart"),
    false,
  )
  await run.instance.close()
  await first
})

test("disabled plugins require no source file and cannot consume matching messages", async t => {
  const root = temporary(t)
  const config = settings([plugin("disabled", { enabled: false, match: "*" }), plugin("enabled")])
  const directory = path.join(root, "data/yunzai-guard/scripts")
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, "enabled.js"), 'onMessage=()=>guard.reply("enabled")')
  const loaded = loadSandboxSources(root, config.pluginSandbox)
  assert.deepEqual(
    loaded.map(item => item.id),
    ["enabled"],
  )
  assert.deepEqual(
    loadSandboxSources(
      temporary(t),
      settings([plugin("disabled", { enabled: false })]).pluginSandbox,
    ),
    [],
  )
  const run = dispatcher(t, root, config, {
    disabled: 'onMessage=()=>guard.reply("disabled")',
    enabled: 'onMessage=()=>guard.reply("enabled")',
  })
  assert.equal(await run.dispatch("ordinary"), false)
  assert.equal(await run.dispatch("#enabled"), true)
  assert.deepEqual(run.replies, ["enabled"])
})
