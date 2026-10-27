import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fork } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const moduleRoot = path.resolve(process.env.GUARD_TEST_MODULE_ROOT ?? path.join(repository, "dist"))
const entry = path.join(moduleRoot, "native-sandbox/child.js")
const { validateNativeDescriptor } = await import(
  pathToFileURL(path.join(moduleRoot, "native-sandbox/validation.js"))
)
const runs = path.join(repository, "tests/runs")
const coreRestartSnapshot = path.join(
  process.env.GUARD_TEST_CORE_SOURCE ?? path.join(repository, "tests/runs/ecosystem-core/source"),
  "plugins/other/restart.js",
)
const write = (root, name, content) => {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

async function fixture(t, source) {
  fs.mkdirSync(runs, { recursive: true })
  const root = fs.mkdtempSync(path.join(runs, "native-child-"))
  write(
    root,
    "package.json",
    JSON.stringify({ type: "module", imports: { "#fixture": "./shared.mjs" } }),
  )
  write(root, "shared.mjs", 'export default "package-import"')
  write(
    root,
    "lib/plugins/plugin.js",
    `export const PluginCleanup=Symbol("PluginCleanup")
  export default class plugin {
    constructor(options){Object.assign(this, options)}
    reply(...args){return this.e.reply(...args)}
    getContext(){return "base-only"}
    addCleanup(dispose,restore){(this[PluginCleanup]??=[]).push({dispose,restore,active:true})}
  }`,
  )
  write(root, "lib/bot.js", 'throw new Error("core Bot must never execute")')
  for (const name of ["lodash", "oicq"]) {
    write(
      root,
      `node_modules/${name}/package.json`,
      JSON.stringify({ name, type: "module", main: "index.js" }),
    )
    write(
      root,
      `node_modules/${name}/index.js`,
      name === "lodash"
        ? "export default {identity:value=>value}"
        : 'export const segment={text:text=>({type:"text",text})}',
    )
  }
  write(root, "plugins/sample/index.js", source)
  write(root, "plugins/sample/counter.cjs", "module.exports={value:1}")
  write(root, "plugins/sample/dynamic.mjs", 'export default "dynamic-import"')
  const original = fs.readFileSync(path.join(root, "plugins/sample/index.js"), "utf8")
  const messages = [],
    pending = new Map()
  let sequence = 0,
    output = "",
    readyResolve,
    readyReject
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const readyTimer = setTimeout(
    () => readyReject(new Error("native-ready timeout: " + output)),
    5000,
  )
  const child = fork(entry, [], {
    cwd: root,
    execArgv: [],
    silent: true,
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      YUNZAI_GUARD_PIPE: "",
      YUNZAI_GUARD_RUNTIME_MANIFEST: "",
    },
  })
  child.stdout.on("data", bytes => {
    output += bytes
  })
  child.stderr.on("data", bytes => {
    output += bytes
  })
  child.on("error", readyReject)
  child.on("message", message => {
    messages.push(message)
    if (message.type === "native-ready") {
      clearTimeout(readyTimer)
      readyResolve(message)
    }
    if (message.type === "native-result") {
      const request = pending.get(message.requestId)
      if (request) {
        pending.delete(message.requestId)
        clearTimeout(request.timer)
        request.resolve(message)
      }
    }
    if (message.type === "native-service") {
      if (message.service === "event" && ["reply", "handlerReject"].includes(message.method))
        child.send({
          type: "native-service-result",
          id: message.id,
          ok: true,
          value: { message_id: "test-reply" },
        })
      else if (message.service === "redis" && message.method === "get")
        child.send({
          type: "native-service-result",
          id: message.id,
          ok: true,
          value: "redis-value",
        })
      else
        child.send({
          type: "native-service-result",
          id: message.id,
          ok: false,
          error: { code: "SERVICE_DENIED", message: "Test parent allowlist rejected method" },
        })
    }
  })
  t.after(async () => {
    clearTimeout(readyTimer)
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(new Error("Fixture closed"))
    }
    if (child.exitCode === null && child.signalCode === null) {
      const exit = new Promise(resolve => child.once("exit", resolve))
      child.kill()
      await exit
    }
    assert.equal(fs.readFileSync(path.join(root, "plugins/sample/index.js"), "utf8"), original)
    const canonical = fs.realpathSync.native(root)
    const parent = fs.realpathSync.native(runs)
    assert.equal(path.dirname(canonical), parent)
    assert.ok(path.basename(canonical).startsWith("native-child-"))
    fs.rmSync(canonical, { recursive: true, force: true })
  })
  await ready
  const request = (type, fields = {}) => {
    const requestId = String(++sequence)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error("native request timed out: " + output))
      }, 5000)
      pending.set(requestId, { resolve, reject, timer })
      child.send({ type, requestId, ...fields })
    })
  }
  return {
    root,
    child,
    request,
    messages,
    load: (file = "index.js", extra = {}) =>
      request("native-load", {
        root,
        pluginRoot: path.join(root, "plugins/sample"),
        entry: file,
        ...extra,
      }),
    call: (method, fields = {}) =>
      request("native-call", { classId: "index.js#Sample", method, ...fields }),
  }
}

const source = `import shared from "#fixture"
import {createRequire} from "node:module"
const require=createRequire(import.meta.url)
const cjs=require("./counter.cjs")
const same=cjs===require("./counter.cjs")
await Promise.resolve()
const dynamic=(await import("./dynamic.mjs?version=1")).default
logger.info("fixture", shared)
export const apps={Sample:class Sample extends plugin {
  constructor(){super({name:"Sample",event:"message",priority:10,rule:[{reg:/^#fixture$/u,fnc:"run"}],task:{name:"task",fnc:"job",cron:"0 * * * * *"}});this.own=()=>"own"}
  init(){this.task.cron="1 * * * * *";this.counter=(this.counter||0)+1;return this.counter}
  async run(e){const value=await redis.get("key");await this.reply("reply:"+e.msg+":"+value);return {shared,dynamic,same,pid:process.pid,native:typeof process,counter:this.counter??null}}
  hook(){try{Bot.em=()=>{}}catch(error){return error.code}}
  unsupported(){return Bot.pickUser("test")}
  deniedService(){return redis.set("key","value")}
  blockedImport(){return import("../../lib/bot.js")}
  large(){return "x".repeat(70000)}
  job(){return true}
}}
`

test("native class descriptors preserve constructor names independently of display names and export aliases", async t => {
  const f = await fixture(
    t,
    `class OriginalClass extends plugin {
      constructor(){super({name:"Named display",priority:10,rule:[]})}
    }
    const Anonymous=(0,class extends plugin {
      constructor(){super({name:"Anonymous display",priority:10,rule:[]})}
    })
    export const apps={RenamedExport:OriginalClass,Anonymous}`,
  )
  const loaded = await f.load()
  assert.equal(loaded.ok, true, JSON.stringify(loaded))
  assert.deepEqual(
    loaded.value.classes.map(({ id, name, metadata }) => ({ id, name, display: metadata.name })),
    [
      { id: "index.js#RenamedExport", name: "OriginalClass", display: "Named display" },
      { id: "index.js#Anonymous", name: "", display: "Anonymous display" },
    ],
  )
  for (const descriptor of loaded.value.classes)
    assert.doesNotThrow(() => validateNativeDescriptor(descriptor))
})

test("notice rules without reg preserve the original loader's guest-side RegExp conversion", async t => {
  const f = await fixture(
    t,
    `
    export class Sample extends plugin {
      constructor(){super({name:"Notice",event:"notice.*.poke",priority:10,rule:[
        {fnc:"run"},{reg:null,fnc:"run"},{reg:7,fnc:"run"},{reg:false,fnc:"run"}
      ]})}
      run(){return true}
    }
  `,
  )
  const loaded = await f.load()
  assert.equal(loaded.ok, true)
  const descriptor = loaded.value.classes[0]
  assert.doesNotThrow(() => validateNativeDescriptor(descriptor))
  assert.deepEqual(
    descriptor.metadata.rule.map(rule => rule.reg.source),
    ["(?:)", "null", "7", "false"],
  )
  for (const [ruleIndex, text, expected] of [
    [0, "any notice", true],
    [1, "null", true],
    [1, "other", false],
    [2, "7", true],
    [3, "false", true],
  ]) {
    const result = await f.request("native-match", { classId: "index.js#Sample", ruleIndex, text })
    assert.equal(result.ok, true)
    assert.equal(result.value, expected)
  }
})

test("an absent rule handler uses a guest no-op stub without invoking any host base method", async t => {
  const f = await fixture(
    t,
    `
    export class Sample extends plugin {
      constructor(){super({name:"Legacy absent handler",event:"message",priority:10,rule:[
        {reg:"^missing$",fnc:"missingRule"},{reg:"^normal$",fnc:"run"}
      ]})}
      run(){return "original method"}
    }
  `,
  )
  const loaded = await f.load()
  assert.equal(loaded.ok, true)
  const descriptor = loaded.value.classes[0]
  assert.doesNotThrow(() => validateNativeDescriptor(descriptor))
  const alias = descriptor.metadata.rule[0].fnc
  assert.match(alias, /^guardMissingRule_[0-9a-f]{32}$/)
  assert.ok(descriptor.methods.includes(alias))
  assert.equal(descriptor.methods.includes("missingRule"), false)
  assert.equal((await f.call(alias)).value.result, null)
  assert.equal((await f.call("missingRule")).error.code, "UNKNOWN_METHOD")
  assert.equal((await f.call("run")).value.result, "original method")
  assert.equal((await f.call("arbitraryMissing")).error.code, "UNKNOWN_METHOD")
})

test("missing namespace and init-added rule handlers share a pre-registered guest no-op alias", async t => {
  const f = await fixture(
    t,
    `let constructors=0
    export class Sample extends plugin {
      constructor(){super({name:"Missing field collision",event:"message",priority:10,rule:[{reg:"^namespace$",fnc:"namespace"}]});constructors++}
      init(){this.rule.push({reg:"^dynamic$",fnc:"afterInitMissing"})}
      valid(){return {constructors,namespace:typeof this.namespace}}
    }`,
  )
  const loaded = await f.load()
  assert.equal(loaded.ok, true, JSON.stringify(loaded))
  const descriptor = loaded.value.classes[0],
    alias = descriptor.metadata.rule[0].fnc
  assert.ok(descriptor.methods.includes(alias))
  for (const name of ["namespace", "afterInitMissing"])
    assert.equal(descriptor.methods.includes(name), false)
  const initialized = await f.call("init")
  assert.equal(initialized.ok, true, JSON.stringify(initialized))
  assert.deepEqual(
    initialized.value.metadata.rule.map(rule => rule.fnc),
    [alias, alias],
  )
  assert.doesNotThrow(() =>
    validateNativeDescriptor({ ...descriptor, metadata: initialized.value.metadata }),
  )
  assert.equal((await f.call(alias, { event: { msg: "namespace" } })).value.result, null)
  const valid = await f.call("valid")
  assert.equal(valid.value.result.namespace, "undefined")
  assert.equal(
    valid.value.result.constructors,
    3,
    "The no-op still constructs the original Guest message instance",
  )
  assert.equal((await f.call("afterInitMissing")).error.code, "UNKNOWN_METHOD")
})

test("the no-op alias does not expand init-added arbitrary real method membership", async t => {
  const f = await fixture(
    t,
    `export class Sample extends plugin {
    constructor(){super({name:"Dynamic real method",priority:10,rule:[]})}
    init(){this.dynamicReal=()=>"not declared at load";this.rule.push({reg:"^dynamic$",fnc:"dynamicReal"})}
  }`,
  )
  const loaded = await f.load(),
    descriptor = loaded.value.classes[0]
  const initialized = await f.call("init")
  assert.equal(initialized.ok, true)
  assert.equal(initialized.value.metadata.rule[0].fnc, "dynamicReal")
  assert.equal(descriptor.methods.includes("dynamicReal"), false)
  assert.throws(
    () => validateNativeDescriptor({ ...descriptor, metadata: initialized.value.metadata }),
    /规则须引用已登记的插件方法：dynamicReal/,
  )
})

test("a confirmed missing rule never drifts back to Host fields after init or request-local e appears", async t => {
  const f = await fixture(
    t,
    `export class Sample extends plugin {
    constructor(){super({name:"Placeholder",priority:10,rule:[{reg:"^name$",fnc:"name"},{reg:"^event$",fnc:"e"}]});this.name=undefined}
    init(){this.name="Initialized display"}
  }`,
  )
  const loaded = await f.load(),
    descriptor = loaded.value.classes[0]
  const alias = descriptor.metadata.rule[0].fnc
  assert.deepEqual(
    descriptor.metadata.rule.map(rule => rule.fnc),
    [alias, alias],
  )
  assert.equal(descriptor.methods.includes("name"), false)
  assert.equal(descriptor.methods.includes("e"), false)
  const initialized = await f.call("init")
  assert.equal(initialized.value.metadata.name, "Initialized display")
  assert.deepEqual(
    initialized.value.metadata.rule.map(rule => rule.fnc),
    [alias, alias],
  )
  assert.doesNotThrow(() =>
    validateNativeDescriptor({ ...descriptor, metadata: initialized.value.metadata }),
  )
  const response = await f.call(alias, { event: { msg: "event" } })
  assert.equal(response.ok, true)
  assert.equal(response.value.result, null)
  assert.deepEqual(
    response.value.metadata.rule.map(rule => rule.fnc),
    [alias, alias],
  )
})

test("the internal no-op slot preserves 256 real methods and rejects a 257th business method", async t => {
  for (const count of [256, 257])
    await t.test(String(count), async t => {
      const f = await fixture(
        t,
        `export class Sample extends plugin {constructor(){super({name:"Method limit",priority:10,rule:[]})}}
      for(let index=0;index<${count};index++)Object.defineProperty(Sample.prototype,"method_"+index,{value(){return index}})`,
      )
      const loaded = await f.load()
      if (count === 257) {
        assert.equal(loaded.ok, false)
        assert.equal(loaded.error.code, "METHOD_LIMIT")
        return
      }
      assert.equal(loaded.ok, true, JSON.stringify(loaded))
      const descriptor = loaded.value.classes[0]
      assert.equal(descriptor.methods.length, 257)
      assert.match(descriptor.methods[256], /^guardMissingRule_[0-9a-f]{32}$/)
      assert.doesNotThrow(() => validateNativeDescriptor(descriptor))
      assert.equal((await f.call("method_255")).value.result, 255)
    })
})

test("repeated private alias collisions fail closed instead of invoking a class property", async t => {
  const f = await fixture(
    t,
    `import crypto from "node:crypto"
    import {syncBuiltinESMExports} from "node:module"
    crypto.randomUUID=()=>"11111111-1111-1111-1111-111111111111";syncBuiltinESMExports()
    export class Sample extends plugin {
      constructor(){super({name:"Forced alias collision",rule:[]});this.guardMissingRule_11111111111111111111111111111111=undefined}
    }`,
  )
  const loaded = await f.load()
  assert.equal(loaded.ok, false)
  assert.equal(loaded.error.code, "METHOD_ALIAS_COLLISION")
})

test(
  "original core Restart imports without executing the real loader, while global loader control stays unavailable",
  {
    timeout: 15000,
    skip: fs.existsSync(coreRestartSnapshot)
      ? false
      : "requires the pinned real-core ecosystem snapshot",
  },
  async t => {
    const f = await fixture(
      t,
      `
    import {Restart} from "../other/restart.js"
    import loader from "../../lib/plugins/loader.js"
    export class Sample extends plugin {
      constructor(){super({name:"Original restart import"})}
      legacy(){return new Restart(this.e).priority===-Infinity}
      read(){return loader.priority}
      hook(){loader.priority=[]}
      restart(){return Bot.restart()}
    }`,
    )
    const original = fs.readFileSync(coreRestartSnapshot, "utf8")
    write(f.root, "plugins/other/restart.js", original)
    write(f.root, "lib/config/config.js", "export default {bot:{}}")
    write(
      f.root,
      "lib/plugins/loader.js",
      'throw new Error("Real core loader must never execute in business guest")',
    )
    assert.equal((await f.load()).ok, true)
    assert.equal((await f.call("legacy")).value.result, true)
    assert.equal((await f.call("read")).error.code, "UNSUPPORTED_API")
    assert.equal((await f.call("hook")).error.code, "HOST_HOOK_DENIED")
    const restarted = await f.call("restart", { event: { isMaster: true } })
    // 夹具拒绝宿主服务，以验证客户请求经过能力代理，不自行启动核心或调用退出、创建进程。
    assert.equal(restarted.error.code, "SERVICE_DENIED")
    const frame = f.messages.find(
      message => message.service === "core" && message.method === "restart",
    )
    assert.equal(frame.requestId, restarted.requestId)
    assert.deepEqual(frame.args, [])
    assert.ok(
      f.messages.some(
        message => message.type === "native-hook" && message.target === "PluginsLoader.priority",
      ),
    )
    assert.equal(fs.readFileSync(path.join(f.root, "plugins/other/restart.js"), "utf8"), original)
  },
)

test("unchanged plugin negative-infinite priority and handler ordering survive native serialization", async t => {
  const f = await fixture(
    t,
    `export class Sample extends plugin {
    constructor(){super({name:"Original ordering",priority:-Infinity,rule:[],handler:[{key:"ordering",priority:Infinity,fn:()=>true}]})}
  }`,
  )
  const result = await f.load()
  assert.equal(result.ok, true, JSON.stringify(result))
  const metadata = result.value.classes[0].metadata
  assert.deepEqual(metadata.priority, { $type: "NativePriority", value: "negative-infinity" })
  assert.deepEqual(metadata.handler[0].priority, {
    $type: "NativePriority",
    value: "positive-infinity",
  })
})

test("ordinary original plugins recognize TRSS Bot.uin without receiving account capabilities", async t => {
  const f = await fixture(
    t,
    `export class Sample extends plugin {
    constructor(){super({name:Array.isArray(Bot.uin)?"TRSS original":"wrong runtime",priority:10,rule:[]})}
    inspect(){Bot.uin.push("local-copy");return {ids:[...Bot.uin]}}
    cannotSend(){return Bot.pickFriend(123)}
  }`,
  )
  const loaded = await f.load("index.js", { botState: { uin: ["stdin", 123] } })
  assert.equal(loaded.ok, true, JSON.stringify(loaded))
  assert.equal(loaded.value.classes[0].name, "Sample")
  assert.equal(loaded.value.classes[0].metadata.name, "TRSS original")
  const inspected = await f.call("inspect", { botState: { uin: ["stdin", 456] } })
  assert.equal(inspected.ok, true, JSON.stringify(inspected))
  assert.deepEqual(inspected.value.result.ids, ["stdin", 456, "local-copy"])
  // 缺失的账号方法仍须报错，仅有账号 ID 不授予发送权限。
  const denied = await f.call("cannotSend")
  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, "UNSUPPORTED_API")
})

test(
  "native child preserves ESM/TLA/package imports/CJS cache and uses DTO service bridges",
  { timeout: 15000 },
  async t => {
    const fixtureCase = await fixture(t, source)
    const loaded = await fixtureCase.load()
    assert.equal(loaded.ok, true, JSON.stringify(loaded))
    const definition = loaded.value.classes[0]
    assert.equal(definition.id, "index.js#Sample")
    assert.deepEqual(definition.metadata.rule[0].reg, {
      $type: "RegExp",
      source: "^#fixture$",
      flags: "u",
    })
    assert.ok(definition.methods.includes("own"))
    assert.equal(definition.methods.includes("reply"), false)
    assert.equal(definition.methods.includes("getContext"), false)
    const initialized = await fixtureCase.call("init")
    assert.equal(initialized.value.result, 1)
    assert.equal(initialized.value.metadata.task.cron, "1 * * * * *")
    assert.equal((await fixtureCase.call("init")).value.result, 2)
    const called = await fixtureCase.call("run", { event: { msg: "hello" } })
    assert.equal(called.ok, true, JSON.stringify(called))
    assert.deepEqual(called.value.result, {
      shared: "package-import",
      dynamic: "dynamic-import",
      same: true,
      pid: fixtureCase.child.pid,
      native: "object",
      counter: null,
    })
    const reply = fixtureCase.messages.find(
      row => row.type === "native-service" && row.service === "event",
    )
    assert.deepEqual(reply.args, ["reply:hello:redis-value", false, {}])
    assert.equal(reply.requestId, called.requestId)
    assert.ok(fixtureCase.messages.some(row => row.type === "native-log" && row.level === "info"))
  },
)

test(
  "native child reports unsupported APIs, host hooks, service denials and oversized results",
  { timeout: 15000 },
  async t => {
    const fixtureCase = await fixture(t, source)
    assert.equal((await fixtureCase.load()).ok, true)
    assert.equal((await fixtureCase.call("hook")).value.result, "HOST_HOOK_DENIED")
    assert.ok(
      fixtureCase.messages.some(row => row.type === "native-hook" && row.target === "Bot.em"),
    )
    assert.equal((await fixtureCase.call("unsupported")).error.code, "UNSUPPORTED_API")
    assert.equal((await fixtureCase.call("deniedService")).error.code, "SERVICE_DENIED")
    assert.equal((await fixtureCase.call("blockedImport")).error.code, "CORE_IMPORT_DENIED")
    assert.equal((await fixtureCase.call("large")).error.code, "FRAME_TOO_LARGE")
    assert.equal((await fixtureCase.call("getContext")).error.code, "UNKNOWN_METHOD")
    assert.equal((await fixtureCase.call("own")).value.result, "own")
  },
)

test(
  "native child loads multiple untouched entry files with distinct class IDs and fixed roots",
  { timeout: 15000 },
  async t => {
    const fixtureCase = await fixture(t, source)
    const first = await fixtureCase.load()
    write(
      fixtureCase.root,
      "plugins/sample/second.js",
      'export class Sample extends plugin {constructor(){super({name:"Second"})}run(){return "second"}}',
    )
    const second = await fixtureCase.load("second.js")
    assert.equal(first.value.classes[0].id, "index.js#Sample")
    assert.equal(second.value.classes[0].id, "second.js#Sample")
    assert.equal(
      (await fixtureCase.request("native-call", { classId: "second.js#Sample", method: "run" }))
        .value.result,
      "second",
    )
    write(fixtureCase.root, "plugins/other/index.js", "export default {}")
    assert.equal(
      (
        await fixtureCase.load("index.js", {
          pluginRoot: path.join(fixtureCase.root, "plugins/other"),
        })
      ).error.code,
      "ROOT_CHANGED",
    )
  },
)

test(
  "functions outside task/handler metadata are rejected and parent disconnect exits child",
  { timeout: 15000 },
  async t => {
    const fixtureCase = await fixture(
      t,
      'export class Sample extends plugin {constructor(){super({name:"Function rule",rule:[{reg:"x",fnc:()=>{}}]})}}',
    )
    assert.equal((await fixtureCase.load()).error.code, "UNSUPPORTED_METADATA")
    const exit = new Promise(resolve => fixtureCase.child.once("exit", resolve))
    fixtureCase.child.disconnect()
    assert.equal(await exit, 0)
  },
)

test(
  "native matching stays in child and preserves string patterns and RegExp lastIndex",
  { timeout: 15000 },
  async t => {
    const fixtureCase = await fixture(
      t,
      source.replace(
        'rule:[{reg:/^#fixture$/u,fnc:"run"}]',
        'rule:[{reg:/^#fixture$/u,fnc:"run"},{reg:/x/g,fnc:"run"},{reg:"^hello$",fnc:"run"}]',
      ),
    )
    assert.equal((await fixtureCase.load()).ok, true)
    const match = (ruleIndex, text) =>
      fixtureCase.request("native-match", { classId: "index.js#Sample", ruleIndex, text })
    assert.equal((await match(0, "#fixture")).value, true)
    assert.equal((await match(0, "hello")).value, false)
    assert.equal((await match(2, "hello")).value, true)
    assert.equal((await match(1, "x")).value, true)
    assert.equal((await match(1, "x")).value, false)
    assert.equal((await match(1, "x")).value, true)
    assert.equal((await match(99, "x")).error.code, "UNKNOWN_RULE")
  },
)

test(
  "task and handler functions become class-owned handles bound to the initial instance",
  { timeout: 15000 },
  async t => {
    const fixtureCase = await fixture(
      t,
      `await Promise.resolve()
export class Sample extends plugin {
  constructor(){super({name:"Callbacks",task:{name:"task",cron:"0 * * * * *",fnc:async function(amount){await Promise.resolve();this.total=(this.total||0)+amount;return this.total}},handler:{example:{fn:async function(e){await this.reply(e.msg);return this.name}}}})}
  init(){this.name="Initialized callbacks"}
}
export class Other extends plugin {constructor(){super({name:"Other"})}}
`,
    )
    const loaded = await fixtureCase.load()
    assert.equal(loaded.ok, true, JSON.stringify(loaded))
    const sample = loaded.value.classes.find(row => row.id === "index.js#Sample")
    const taskHandle = sample.metadata.task.fnc
    const handlerHandle = sample.metadata.handler.example.fn
    assert.equal(taskHandle.$type, "NativeFunction")
    assert.match(taskHandle.id, /^cb-[0-9a-f-]+$/)
    assert.equal(typeof taskHandle.source, "undefined")
    await fixtureCase.call("init")
    const callback = (handle, fields = {}) =>
      fixtureCase.request("native-callback", { classId: "index.js#Sample", handle, ...fields })
    assert.equal((await callback(taskHandle.id, { args: [3] })).value.result, 3)
    const repeated = await callback(taskHandle.id, { args: [2] })
    assert.equal(repeated.value.result, 5)
    assert.equal(repeated.value.metadata.task.fnc.id, taskHandle.id)
    const handled = await callback(handlerHandle.id, { event: { msg: "handler reply" } })
    assert.equal(handled.value.result, "Initialized callbacks")
    assert.ok(
      fixtureCase.messages.some(
        row =>
          row.type === "native-service" &&
          row.service === "event" &&
          row.args[0] === "handler reply" &&
          row.requestId === handled.requestId,
      ),
    )
    assert.equal((await callback("cb-missing")).error.code, "UNKNOWN_CALLBACK")
    assert.equal(
      (await callback(taskHandle.id, { classId: "index.js#Other" })).error.code,
      "UNKNOWN_CALLBACK",
    )
  },
)

test(
  "native dispose awaits registered cleanup in order and leaves OS shutdown to its parent",
  { timeout: 15000 },
  async t => {
    const fixtureCase = await fixture(
      t,
      `import fs from "node:fs"
export class Sample extends plugin {
  constructor(){super({name:"Cleanup"})}
  init(){
    this.addCleanup(async function(){await new Promise(resolve=>setTimeout(resolve,15));fs.appendFileSync("plugins/sample/disposed.txt",this.name+":first\\n")})
    this.addCleanup(function(){fs.appendFileSync("plugins/sample/disposed.txt",this.name+":second\\n")})
  }
}
`,
    )
    assert.equal((await fixtureCase.load()).ok, true)
    assert.equal((await fixtureCase.call("init")).ok, true)
    const result = await fixtureCase.request("native-dispose")
    assert.equal(result.ok, true)
    assert.deepEqual(result.value, { initializers: 1, disposed: 2, failed: 0, errors: [] })
    assert.equal(
      fs.readFileSync(path.join(fixtureCase.root, "plugins/sample/disposed.txt"), "utf8"),
      "Cleanup:first\nCleanup:second\n",
    )
    assert.deepEqual((await fixtureCase.request("native-dispose")).value, {
      initializers: 1,
      disposed: 0,
      failed: 0,
      errors: [],
    })
    assert.equal(fixtureCase.child.connected, true)
    assert.equal(fixtureCase.child.exitCode, null)
    const exit = new Promise(resolve => fixtureCase.child.once("exit", resolve))
    fixtureCase.child.disconnect()
    assert.equal(await exit, 0)
  },
)

test(
  "derived logger and Bot objects may shadow properties without mutating protected APIs",
  { timeout: 15000 },
  async t => {
    const f = await fixture(
      t,
      `export class Sample extends plugin {
      constructor(){super({name:"Derived APIs"})}
      run(){
        const trace=logger.trace, sleep=Bot.sleep, get=redis.get
        const local=Object.create(logger), bot=Object.create(Bot), cache=Object.create(redis)
        local.trace=()=>"local-log"; bot.sleep=()=>"local-sleep"; cache.get=()=>"local-cache"
        const denied=[]
        for(const target of [logger,new Proxy(logger,{})])try{target.trace=()=>"hook"}catch(error){denied.push(error.code)}
        return {values:[local.trace(),bot.sleep(),cache.get()],same:logger.trace===trace&&Bot.sleep===sleep&&redis.get===get,denied}
      }
    }`,
    )
    assert.equal((await f.load()).ok, true)
    const result = await f.call("run")
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.value.result, {
      values: ["local-log", "local-sleep", "local-cache"],
      same: true,
      denied: ["HOST_HOOK_DENIED", "HOST_HOOK_DENIED"],
    })
    assert.deepEqual(
      f.messages.filter(row => row.type === "native-hook").map(row => row.target),
      ["logger.trace", "logger.trace"],
    )
  },
)

test(
  "audit hook policy records changes to the guest copy without exporting host references",
  { timeout: 15000 },
  async t => {
    const fixtureCase = await fixture(
      t,
      `export class Sample extends plugin {
    constructor(){super({name:"Guest hook audit"})}
    run(){Bot.extra=()=>"guest-only"; const result=Bot.extra(); delete Bot.extra; return result}
    replace(){Bot={local:true};return Bot.local}
  }`,
    )
    assert.equal((await fixtureCase.load("index.js", { hookAction: "audit" })).ok, true)
    assert.equal((await fixtureCase.call("run")).value.result, "guest-only")
    assert.equal((await fixtureCase.call("replace")).value.result, true)
    assert.deepEqual(
      fixtureCase.messages.filter(row => row.type === "native-hook").map(row => row.target),
      ["Bot.extra", "Bot.extra", "Bot"],
    )
    assert.equal(
      (await fixtureCase.load("index.js", { hookAction: "deny" })).error.code,
      "POLICY_CHANGED",
    )
  },
)

test(
  "common and utility modules execute only in the guest with native module caching",
  { timeout: 15000 },
  async t => {
    const fixtureCase = await fixture(
      t,
      `import common from "../../lib/common/common.js"
    import util from "../../lib/util.js"
    export class Sample extends plugin {
      constructor(){super({name:"Native common"})}
      run(){return {common:common.value(),utility:Bot.utility(),same:util===globalThis.__utility,forward:Bot.makeForwardArray("text")}}
    }`,
    )
    write(fixtureCase.root, "lib/common/common.js", 'export default {value:()=>"common-guest"}')
    write(
      fixtureCase.root,
      "lib/util.js",
      'const utility=new(class {utility(){return "utility-guest"}})();globalThis.__utility=utility;export default utility',
    )
    assert.equal((await fixtureCase.load()).ok, true)
    assert.deepEqual((await fixtureCase.call("run")).value.result, {
      common: "common-guest",
      utility: "utility-guest",
      same: true,
      forward: { type: "node", data: [{ message: "text" }] },
    })
    assert.equal(globalThis.__utility, undefined)
  },
)

test(
  "an async message can wait for a later message without serializing the whole plugin",
  { timeout: 15000 },
  async t => {
    const fixtureCase = await fixture(
      t,
      `let release
    export class Sample extends plugin {
      constructor(){super({name:"Concurrent messages"})}
      async wait(e){await new Promise(resolve=>{release=resolve});await this.reply("first:"+e.msg);return true}
      async signal(e){release();await this.reply("second:"+e.msg);return true}
    }`,
    )
    assert.equal((await fixtureCase.load()).ok, true)
    const waiting = fixtureCase.call("wait", { event: { msg: "A" } })
    const signal = await fixtureCase.call("signal", { event: { msg: "B" } })
    const first = await waiting
    assert.equal(signal.ok, true)
    assert.equal(first.ok, true)
    const replies = fixtureCase.messages.filter(
      row => row.type === "native-service" && row.method === "reply",
    )
    assert.ok(replies.some(row => row.args[0] === "first:A" && row.requestId === first.requestId))
    assert.ok(replies.some(row => row.args[0] === "second:B" && row.requestId === signal.requestId))
  },
)

test(
  "handler arguments and reject use value DTOs and a request-specific capability",
  { timeout: 15000 },
  async t => {
    const fixtureCase = await fixture(
      t,
      `export class Sample extends plugin {
    constructor(){super({name:"Handler arguments"})}
    async handler(e,args,reject){await reject(args.reason);return {message:e.msg,argument:args.value}}
  }`,
    )
    assert.equal((await fixtureCase.load()).ok, true)
    const result = await fixtureCase.call("handler", {
      event: { msg: "test" },
      eventArgs: [{ reason: "next handler", value: 42 }],
      handlerReject: true,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.value.result, { message: "test", argument: 42 })
    const request = fixtureCase.messages.find(
      row => row.type === "native-service" && row.method === "handlerReject",
    )
    assert.equal(request.requestId, result.requestId)
    assert.deepEqual(request.args, ["next handler"])
  },
)
