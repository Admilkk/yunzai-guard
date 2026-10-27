import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { performance } from "node:perf_hooks"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { parseSettings } from "../dist/config/index.js"
import { SandboxExecutor } from "../dist/plugin-sandbox/executor.js"
import { SandboxDispatcher, validateSandboxActions } from "../dist/plugin-sandbox/dispatcher.js"
import {
  loadSandboxSources,
  sandboxWriteTarget,
  writeSandboxText,
} from "../dist/plugin-sandbox/filesystem.js"

const config = (capabilities, timeoutMs = 1000) =>
  parseSettings({
    strictJs: {
      plugins: [{ id: "probe", match: "#strict*", capabilities }],
      timeoutMs,
      memoryMiB: 4,
    },
  })
const source = (code, settings = config(["reply", "writeText"])) => ({
  ...settings.pluginSandbox.plugins[0],
  source: code,
  sha256: "test",
})
const event = {
  message: "#strict hello",
  userId: "user",
  groupId: "",
  selfId: "bot",
  isGroup: false,
}

test("explicit global audit for a legacy script failure overrides its configured restart fallback", async t => {
  const settings = parseSettings({
    pluginSandbox: {
      plugins: [{ id: "probe", match: "#strict*", capabilities: [], violationAction: "restart" }],
    },
    rules: [
      {
        id: "observe-errors",
        kind: "plugin-sandbox",
        operation: "sandbox.violation",
        action: "audit",
      },
    ],
  })
  const events = []
  const dispatcher = new SandboxDispatcher(
    temporary(t),
    settings,
    [source('onMessage=()=>{throw new Error("benign fixture failure")}', settings)],
    event => events.push(event),
    () => {},
  )
  try {
    await dispatcher.dispatch({ msg: "#strict", reply: () => true })
    const failure = events.find(event => event.operation === "sandbox.violation")
    assert.equal(failure.action, "audit")
    assert.equal(failure.ruleId, "observe-errors")
  } finally {
    await dispatcher.close()
  }
})
async function run(code, settings = config(["reply", "writeText"])) {
  const executor = new SandboxExecutor()
  try {
    return await executor.execute(source(code, settings), event, settings.pluginSandbox)
  } finally {
    await executor.close()
  }
}
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-strict-test-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

async function isolatedExecutor(t) {
  const root = temporary(t)
  const sandbox = path.join(root, "plugin-sandbox")
  const protect = path.join(root, "protect")
  fs.mkdirSync(sandbox)
  fs.mkdirSync(protect)
  fs.mkdirSync(path.join(root, "shared"))
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}')
  for (const file of [
    "plugin-sandbox/executor.js",
    "protect/objects.js",
    "protect/intrinsics.js",
    "shared/messages.js",
  ])
    fs.copyFileSync(new URL(`../dist/${file}`, import.meta.url), path.join(root, file))
  const { SandboxExecutor } = await import(pathToFileURL(path.join(sandbox, "executor.js")))
  return { root, sandbox, SandboxExecutor }
}

test("strict mode is opt-in, grants are explicit and unknown capabilities/configuration fail closed", () => {
  assert.deepEqual(parseSettings({}).pluginSandbox.plugins, [])
  for (const input of [
    null,
    { plugins: null },
    { violationAction: null },
    { plugins: [{ id: "../escape", match: "*", capabilities: [] }] },
    { plugins: [{ id: "con", match: "*", capabilities: [] }] },
    { plugins: [{ id: "probe", match: "*", capabilities: ["exec"] }] },
    { plugins: [{ id: "probe", match: "*", capabilities: ["writeText", "writeText"] }] },
    { memoryMiB: 1024 },
    { timeoutMs: 0 },
    { violationAction: "audit" },
    { enabled: true },
  ])
    assert.throws(() => parseSettings({ strictJs: input }))
  assert.ok(Object.isFrozen(config([]).pluginSandbox.plugins[0].capabilities))
})

test("separate interpreter supports async jobs and returns only bounded requested actions", async () => {
  const result = await run(
    'globalThis.onMessage = async e => { await Promise.resolve(); guard.reply(e.message); guard.writeText("state.json", JSON.stringify({n:1})) }',
  )
  assert.deepEqual(result, {
    ok: true,
    actions: [
      { capability: "reply", text: event.message },
      { capability: "writeText", text: '{"n":1}', file: "state.json" },
    ],
  })
})

test("Node globals, native constructor chains, workers and process creation are inaccessible", async t => {
  const root = temporary(t)
  const marker = path.join(root, "escaped.txt")
  const attacks = [
    "typeof process",
    "typeof require",
    "typeof Buffer",
    "typeof Bot",
    "typeof fetch",
    "typeof Worker",
    "typeof WebAssembly",
    '({}).constructor.constructor("return process")()',
    'guard.invoke.constructor("return process")()',
    'guard.reply.constructor("return require")()',
    'event.constructor.constructor("return process")()',
    '(async()=>{}).constructor("return process")()',
    `Function("return process")().getBuiltinModule("fs").writeFileSync(${JSON.stringify(marker)}, "escaped")`,
  ]
  for (const attack of attacks) {
    const code = `onMessage = async () => { let result; try { result = await (${attack}); } catch { result = "blocked"; } guard.reply(String(result)); }`
    const result = await run(code)
    assert.equal(result.ok, true, attack)
    assert.ok(
      (attack === "typeof Bot" ? ["function"] : ["undefined", "blocked"]).includes(
        result.actions[0].text,
      ),
      attack,
    )
    assert.equal(fs.existsSync(marker), false)
  }
  await run('onMessage=()=>{Object.prototype.guardPolluted=true;guard.reply("guest-only")}')
  assert.equal(Object.prototype.guardPolluted, undefined)
})

test("filesystem, network and exec requests are denied even when the guest catches the error", async () => {
  const listener = net.createServer(socket => {
    connections++
    socket.destroy()
  })
  let connections = 0
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve))
  try {
    for (const capability of ["exec", "spawn", "fetch", "readFile", "symlink", "worker"])
      assert.deepEqual(
        await run(
          `onMessage=()=>{try{guard.invoke(${JSON.stringify(capability)},"127.0.0.1:${listener.address().port}")}catch{};guard.reply("must not commit")}`,
        ),
        { ok: false, code: "capability-denied" },
      )
    for (const moduleName of ["node:fs", "./other.js", "data:text/javascript,export default 1"])
      assert.equal(
        (
          await run(
            `onMessage=async()=>{try{await import(${JSON.stringify(moduleName)})}catch{};guard.reply("must not commit")}`,
          )
        ).ok,
        false,
      )
    assert.equal(
      (
        await run(
          'onMessage=()=>{try{guard.reply({toString(){while(true){}}})}catch{};guard.reply("bad")}',
        )
      ).ok,
      false,
    )
    assert.equal(connections, 0)
  } finally {
    await new Promise(resolve => listener.close(resolve))
  }
})

test("resource exhaustion, pending promises, oversized output and flood requests are bounded", async () => {
  const limited = config(["reply", "writeText"], 100)
  for (const code of [
    "onMessage=()=>{while(true){}}",
    'onMessage=()=>{const a=[];while(true)a.push("x".repeat(10000))}',
    "onMessage=()=>new Promise(()=>{})",
    'onMessage=()=>guard.reply("x".repeat(5000))',
    'onMessage=()=>{for(let i=0;i<17;i++)guard.reply("x")}',
    "onMessage=()=>{function again(){Promise.resolve().then(again)}again()}",
  ]) {
    const start = performance.now()
    const result = await run(code, limited)
    assert.equal(result.ok, false, code)
    assert.ok(performance.now() - start < 5000, code)
  }
  assert.equal((await run('onMessage=()=>guard.reply("still alive")')).ok, true)
})

test("broker rejects forged grants, identities and invalid paths independently of interpreter", () => {
  const plugin = source("", config(["reply"]))
  for (const actions of [
    [{ capability: "writeText", file: "a", text: "bad" }],
    [{ capability: "reply", text: "bad", plugin: "other" }],
    [{ capability: "reply", text: "bad", file: "../outside" }],
    Array(17).fill({ capability: "reply", text: "bad" }),
  ])
    assert.throws(() => validateSandboxActions({ ok: true, actions }, plugin))
  for (const file of [
    "../outside",
    "/tmp/a",
    "C:\\a",
    "a/b",
    "a\\b",
    "CON",
    "NUL.txt",
    "a:stream",
    "a.",
    "a\0b",
  ])
    assert.throws(() =>
      validateSandboxActions(
        { ok: true, actions: [{ capability: "writeText", file, text: "bad" }] },
        source(""),
      ),
    )
})

test("file grants write only plugin-owned storage and reject links, cross-plugin paths and quota overflow", t => {
  const root = temporary(t)
  writeSandboxText(root, "probe", "state.json", "first")
  writeSandboxText(root, "probe", "state.json", "second")
  assert.equal(
    fs.readFileSync(path.join(root, "data/yunzai-guard-strict/probe/state.json"), "utf8"),
    "second",
  )
  const outside = path.join(root, "outside.txt")
  fs.writeFileSync(outside, "safe")
  const hard = sandboxWriteTarget(root, "probe", "hard.txt")
  fs.linkSync(outside, hard)
  assert.throws(() => writeSandboxText(root, "probe", "hard.txt", "bad"))
  fs.unlinkSync(hard)
  const alias = path.join(root, "data/yunzai-guard-strict/alias")
  fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir")
  assert.throws(() => writeSandboxText(root, "alias", "outside.txt", "bad"))
  assert.throws(() => writeSandboxText(root, "probe", "../alias/outside.txt", "bad"))
  assert.equal(fs.readFileSync(outside, "utf8"), "safe")
  for (let i = 0; i < 63; i++) writeSandboxText(root, "probe", `f${i}`, "x")
  assert.throws(() => writeSandboxText(root, "probe", "overflow", "bad"))
  writeSandboxText(root, "quota", "full", "x".repeat(1024 * 1024))
  assert.throws(() => writeSandboxText(root, "quota", "extra", "x"))
})

test("dispatcher commits allowed file/reply actions, rejects all actions on policy denial and does not match ordinary messages", async t => {
  const root = temporary(t),
    events = [],
    replies = []
  const settings = config(["writeText", "reply"])
  const plugin = source(
    'onMessage=e=>{guard.writeText("ok.txt","allowed");guard.reply(e.message)}',
    settings,
  )
  const dispatcher = new SandboxDispatcher(
    root,
    settings,
    [plugin],
    event => events.push(event),
    () => {},
  )
  try {
    assert.equal(
      await dispatcher.dispatch({ msg: "ordinary", reply: text => replies.push(text) }),
      false,
    )
    assert.equal(
      await dispatcher.dispatch({ msg: "#strict hello", reply: text => replies.push(text) }),
      true,
    )
    assert.deepEqual(replies, ["#strict hello"])
    assert.equal(
      fs.readFileSync(path.join(root, "data/yunzai-guard-strict/probe/ok.txt"), "utf8"),
      "allowed",
    )
  } finally {
    await dispatcher.close()
  }
  const blocked = parseSettings({
    pluginSandbox: settings.pluginSandbox,
    rules: [
      { id: "deny-reply", kind: "plugin-sandbox", operation: "sandbox.reply", action: "restart" },
    ],
  })
  const deniedRoot = temporary(t)
  const denying = new SandboxDispatcher(
    deniedRoot,
    blocked,
    [source('onMessage=()=>{guard.writeText("forbidden.txt","bad");guard.reply("bad")}', blocked)],
    event => events.push(event),
    () => {},
  )
  try {
    await denying.dispatch({ msg: "#strict", reply: text => replies.push(text) })
  } finally {
    await denying.close()
  }
  assert.equal(
    fs.existsSync(path.join(root, "data/yunzai-guard-strict/probe/forbidden.txt")),
    false,
  )
  assert.ok(events.some(event => event.ruleId === "deny-reply" && event.action === "restart"))
  assert.equal(
    fs.existsSync(path.join(deniedRoot, "data")),
    false,
    "Policy preflight must not create directories",
  )
  assert.deepEqual(replies, ["#strict hello"])
})

test("source loading uses a separate non-plugin directory and rejects missing or linked scripts", t => {
  const root = temporary(t),
    settings = config([])
  assert.throws(() => loadSandboxSources(root, settings.pluginSandbox))
  const dir = path.join(root, "data/yunzai-guard/scripts")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "probe.js"), "onMessage=()=>{}")
  const loaded = loadSandboxSources(root, settings.pluginSandbox)
  assert.equal(loaded[0].source, "onMessage=()=>{}")
  assert.match(loaded[0].sha256, /^[a-f0-9]{64}$/)
  fs.linkSync(path.join(dir, "probe.js"), path.join(dir, "alias"))
  assert.throws(() => loadSandboxSources(root, settings.pluginSandbox))
})

test("host watchdog terminates a stalled engine adapter and missing artifacts never fall back to Node evaluation", async t => {
  const { root, sandbox, SandboxExecutor: IsolatedExecutor } = await isolatedExecutor(t)
  const settings = config([], 100),
    plugin = source(
      `require("node:fs").writeFileSync(${JSON.stringify(path.join(root, "escaped"))},"bad")`,
      settings,
    )
  const missing = new IsolatedExecutor()
  try {
    assert.equal((await missing.execute(plugin, event, settings.pluginSandbox)).ok, false)
  } finally {
    await missing.close()
  }
  // 受信夹具进入执行阶段后，在 vm2 外挂起，以验证父进程看门狗。
  fs.writeFileSync(
    path.join(sandbox, "worker.js"),
    'import {parentPort} from "node:worker_threads";parentPort.postMessage({type:"sandbox-ready"});while(true){}',
  )
  const executor = new IsolatedExecutor(),
    started = performance.now()
  try {
    assert.deepEqual(await executor.execute(plugin, event, settings.pluginSandbox), {
      ok: false,
      code: "hard-timeout",
    })
    assert.ok(performance.now() - started < 5000)
  } finally {
    await executor.close()
  }
  assert.equal(fs.existsSync(path.join(root, "escaped")), false)
})

test(
  "engine startup is separately bounded and readiness cannot extend the guest watchdog",
  { timeout: 20000 },
  async t => {
    const { sandbox, SandboxExecutor: IsolatedExecutor } = await isolatedExecutor(t)
    const settings = config([], 100),
      plugin = source("onMessage=()=>{}", settings)
    const execute = async program => {
      fs.writeFileSync(path.join(sandbox, "worker.js"), program)
      const executor = new IsolatedExecutor()
      try {
        return await executor.execute(plugin, event, settings.pluginSandbox)
      } finally {
        await executor.close()
      }
    }
    // 无害的受信适配器初始化耗时超过原有 2.1 秒总限额。
    assert.deepEqual(
      await execute(
        `import {parentPort} from 'node:worker_threads';setTimeout(()=>{parentPort.postMessage({type:'sandbox-ready'});parentPort.postMessage({ok:true,actions:[]})},2300)`,
      ),
      { ok: true, actions: [] },
    )
    const started = performance.now()
    assert.deepEqual(await execute("while(true){}"), { ok: false, code: "engine-startup-timeout" })
    assert.ok(
      performance.now() - started < 15000,
      "An engine that never becomes ready is still forcibly stopped",
    )
    assert.deepEqual(
      await execute(
        `import {parentPort} from 'node:worker_threads';parentPort.postMessage({type:'sandbox-ready'});parentPort.postMessage({type:'sandbox-ready'});setInterval(()=>{},1000)`,
      ),
      { ok: false, code: "engine-protocol" },
    )
    assert.deepEqual(
      await execute(
        `import {parentPort} from 'node:worker_threads';parentPort.postMessage({ok:true,actions:[]})`,
      ),
      { ok: false, code: "engine-protocol" },
    )
  },
)

test("concurrency admission and shutdown revoke running invocations", async () => {
  const executor = new SandboxExecutor(),
    settings = config([])
  const plugin = source("onMessage=()=>{while(true){}}", settings)
  const first = executor.execute(plugin, event, settings.pluginSandbox)
  const second = executor.execute(plugin, event, settings.pluginSandbox)
  assert.deepEqual(await executor.execute(plugin, event, settings.pluginSandbox), {
    ok: false,
    code: "executor-unavailable",
  })
  await executor.close()
  assert.equal((await first).ok, false)
  assert.equal((await second).ok, false)
  assert.deepEqual(await executor.execute(plugin, event, settings.pluginSandbox), {
    ok: false,
    code: "executor-unavailable",
  })
})
