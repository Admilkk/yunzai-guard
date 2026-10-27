import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { fork } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { NativePluginClient } from "../dist/native-sandbox/client.js"
import { parseSettings } from "../dist/config/index.js"

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const runs = path.join(repository, "tests/runs")
const sha = text => createHash("sha256").update(text).digest("hex")
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const write = (root, name, value) => {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
}
const source = `import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
const own=path.dirname(fileURLToPath(import.meta.url))
let loads=0
const record=(name,data)=>fs.writeFileSync(path.join(own,name),JSON.stringify({pid:process.pid,...data}))
const adapter=new class {
  id="BenignNativeAdapter";name="Benign native adapter";version="fixture"
  async load(){
    loads++;await Promise.resolve()
    Bot.fixture_account={adapter:this,sdk:{secret:"guest-only-secret"},info:{id:"fixture_account",nickname:"account-name",secret:"guest-only-secret"},uin:"fixture_account",
      fl:new Map([["friend",{user_id:"friend",nickname:"friend-name"}]]),gl:new Map(),gml:new Map(),
      pickFriend:user=>({user_id:user,sendMsg:async text=>{
        if(Array.isArray(text))record("image-sent.json",{user,segments:text.map(value=>value?.type==="image"?{type:"image",buffer:Buffer.isBuffer(value.file),bytes:value.file.length,base64:value.file.toString("base64")}:value)})
        else record("sent.json",{user,text});return {message_id:"sent"}
      },getInfo:()=>({nickname:"friend-name"}),getAvatarUrl:async()=>"https://example.invalid/avatar",recallMsg:async()=>true}),
      async logout(){const lookup=Bot.fixture_account.sdk.secret==="guest-only-secret";Bot.em("disconnect.fixture_account",{self_id:"fixture_account"});record("logout.json",{logout:true,lookup})}}
    record("loaded.json",{loads})
    Bot.em("connect.fixture_account",{self_id:"fixture_account"})
    Bot.em("message.private",{self_id:"fixture_account",user_id:"friend",post_type:"message",message_type:"private",message:[{type:"text",text:"from-guest"}],raw_message:"from-guest"})
    return true
  }
}
Bot.adapter.push(adapter)
export class Settings extends plugin {
  constructor(){super({name:"Adapter settings",rule:[]})}
  inspect(){return {pid:process.pid,loads,ids:[...Bot.uin]}}
  async replyImage(e){return e.reply(["before",{type:"image",file:Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=","base64")},"after"])}
}
`

async function fixture(t, { adapters, source: code = source, hookAction = "deny" } = {}) {
  fs.mkdirSync(runs, { recursive: true })
  const root = fs.mkdtempSync(path.join(runs, "native-adapter-child-"))
  write(root, "package.json", '{"type":"module"}')
  write(
    root,
    "lib/plugins/plugin.js",
    "export default class plugin{constructor(options){Object.assign(this,options)}}",
  )
  for (const name of ["lodash", "oicq"]) {
    write(
      root,
      `node_modules/${name}/package.json`,
      JSON.stringify({ name, type: "module", main: "index.js" }),
    )
    write(
      root,
      `node_modules/${name}/index.js`,
      name === "lodash" ? "export default {}" : "export const segment={}",
    )
  }
  write(root, "plugins/fixture/index.js", code)
  const bot = {
    adapter: [],
    uin: [],
    events: [],
    em(name, event) {
      if (event.user_id) {
        event.friend = event.bot.pickFriend(event.user_id)
        event.reply = event.friend.sendMsg.bind(event.friend)
      }
      if (name.startsWith("connect.")) this.uin.push(event.self_id)
      this.events.push({ name, event })
    },
  }
  const originalBot = Object.getOwnPropertyDescriptor(globalThis, "Bot")
  Object.defineProperty(globalThis, "Bot", { configurable: true, writable: true, value: bot })
  const settings = parseSettings({
    pluginSandbox: {
      native: {
        plugins: [
          {
            id: "fixture",
            timeoutMs: 3000,
            ...(adapters === undefined ? {} : { adapters }),
            hookAction,
          },
        ],
      },
    },
  })
  const audit = [],
    protocolErrors = [],
    messages = []
  const client = new NativePluginClient(
    root,
    settings.pluginSandbox.native.plugins[0],
    settings,
    event => audit.push(event),
    () => ({}),
  )
  let output = "",
    resolveReady,
    rejectReady
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const timer = setTimeout(
    () => rejectReady(new Error("Native child handshake timeout: " + output)),
    5000,
  )
  const child = fork(path.join(repository, "dist/native-sandbox/child.js"), [], {
    cwd: root,
    execArgv: [],
    silent: true,
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      YUNZAI_GUARD_PIPE: "",
      YUNZAI_GUARD_RUNTIME_MANIFEST: "",
      YUNZAI_GUARD_SANDBOX: "",
    },
  })
  child.stdout.on("data", value => {
    output += value
  })
  child.stderr.on("data", value => {
    output += value
  })
  child.once("error", rejectReady)
  // 通过 fork IPC 验证真实客户端协议，仅替换系统启动和回收，不代表 AppContainer/bubblewrap 验证。
  client.readyPromise = Promise.resolve()
  client.applicationReady = true
  client.session = {
    child,
    platform: process.platform,
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once("exit", resolve))
        child.kill()
        await exited
      }
    },
  }
  child.on("message", frame => {
    messages.push(frame)
    if (frame.type === "native-ready") {
      clearTimeout(timer)
      resolveReady()
      return
    }
    try {
      client.receive(frame)
    } catch (error) {
      protocolErrors.push(error)
      client.stop(error)
    }
  })
  t.after(async () => {
    clearTimeout(timer)
    await client.close()
    if (originalBot) Object.defineProperty(globalThis, "Bot", originalBot)
    else delete globalThis.Bot
    assert.equal(sha(fs.readFileSync(path.join(root, "plugins/fixture/index.js"))), sha(code))
    assert.equal(path.dirname(fs.realpathSync.native(root)), fs.realpathSync.native(runs))
    assert.match(path.basename(root), /^native-adapter-child-/)
    fs.rmSync(root, { recursive: true, force: true })
  })
  await ready
  return { client, root, child, bot, audit, messages, protocolErrors, settings }
}

test(
  "real native client/child loads a trusted adapter and handles a message/reply in the child process",
  { timeout: 15000 },
  async t => {
    const f = await fixture(t, { adapters: true })
    const loaded = await f.client.load("index.js")
    assert.equal(loaded.classes.length, 1)
    assert.equal(f.bot.adapter.length, 1)
    assert.equal(fs.existsSync(path.join(f.root, "plugins/fixture/loaded.json")), false)
    assert.equal(await f.bot.adapter[0].load(), true)
    const proof = JSON.parse(fs.readFileSync(path.join(f.root, "plugins/fixture/loaded.json")))
    assert.equal(proof.pid, f.child.pid)
    assert.notEqual(proof.pid, process.pid)
    assert.equal(proof.loads, 1)
    const incoming = f.bot.events.find(event => event.name === "message.private").event
    assert.equal(incoming.friend.nickname, "friend-name")
    assert.equal(incoming.friend.then, undefined)
    assert.equal((await incoming.reply("reply-from-host")).message_id, "sent")
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, "plugins/fixture/sent.json"))), {
      pid: f.child.pid,
      user: "friend",
      text: "reply-from-host",
    })
    const inspected = await f.client.request("native-call", {
      classId: "index.js#Settings",
      method: "inspect",
    })
    assert.equal(inspected.result.loads, 1)
    assert.deepEqual(inspected.result.ids, ["fixture_account"])
    assert.equal(f.bot.fixture_account.sdk, undefined)
    assert.doesNotMatch(
      JSON.stringify(f.messages.filter(frame => frame.type === "native-adapter")),
      /guest-only-secret/,
    )
    assert.ok(f.audit.some(event => event.operation === "native.adapter.register"))
    assert.ok(f.audit.some(event => event.operation === "native.adapter.event"))
    await f.client.close()
    assert.equal(f.bot.fixture_account, undefined)
    assert.deepEqual(f.bot.adapter, [])
    assert.deepEqual(f.bot.uin, [])
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(f.root, "plugins/fixture/logout.json"))),
      { pid: f.child.pid, logout: true, lookup: true },
    )
  },
)

test(
  "image reply uploads bytes and restores a Buffer only inside the original adapter SDK",
  { timeout: 15000 },
  async t => {
    const f = await fixture(t, { adapters: true })
    await f.client.load("index.js")
    await f.bot.adapter[0].load()
    const event = f.bot.events.find(event => event.name === "message.private").event
    const result = await f.client.request(
      "native-call",
      { classId: "index.js#Settings", method: "replyImage" },
      event,
    )
    assert.equal(result.result.message_id, "sent")
    const sent = JSON.parse(fs.readFileSync(path.join(f.root, "plugins/fixture/image-sent.json")))
    assert.equal(sent.pid, f.child.pid)
    assert.deepEqual(sent.segments, [
      "before",
      {
        type: "image",
        buffer: true,
        bytes: 68,
        base64:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
      },
      "after",
    ])
    assert.ok(f.messages.some(frame => frame.service === "media" && frame.method === "open"))
    assert.ok(f.messages.some(frame => frame.service === "media-source" && frame.method === "read"))
    assert.deepEqual(f.client.media.stats, { images: 0, bytes: 0, requests: 0 })
    assert.deepEqual(f.client.mediaSource.stats, { sources: 0, bytes: 0, requests: 0 })
    assert.deepEqual(f.protocolErrors, [])
  },
)

test(
  "default configuration denies original adapter registration before any host adapter appears",
  { timeout: 15000 },
  async t => {
    const f = await fixture(t)
    assert.equal(f.settings.pluginSandbox.native.plugins[0].adapters, false)
    await assert.rejects(f.client.load("index.js"), { code: "UNSUPPORTED_API" })
    assert.deepEqual(f.bot.adapter, [])
    assert.deepEqual(f.bot.uin, [])
    assert.equal(f.bot.fixture_account, undefined)
  },
)

test(
  "an ungranted native child cannot forge adapter frames or invoke adapter method capabilities",
  { timeout: 15000 },
  async t => {
    const code = `export class Settings extends plugin {
    constructor(){super({name:"Ungrant fixture",rule:[]})}
    forge(){process.send({type:"native-adapter",frame:{type:"register",adapter:{handle:"adapter-00000000-0000-0000-0000-000000000000",loadHandle:"method-00000000-0000-0000-0000-000000000000",id:"forged",name:"forged",version:"1"}}});return true}
  }`
    const f = await fixture(t, { source: code })
    await f.client.load("index.js")
    await assert.rejects(
      f.client.request("native-adapter-call", {
        call: { methodHandle: "method-00000000-0000-0000-0000-000000000000", args: [] },
      }),
      { code: "ADAPTER_DENIED" },
    )
    await assert.rejects(
      f.client.request("native-call", { classId: "index.js#Settings", method: "forge" }),
      /未授予适配器能力/,
    )
    assert.deepEqual(f.bot.adapter, [])
    assert.equal(f.protocolErrors.length, 1)
  },
)

test(
  "adapter grant does not permit changing the host Bot.em through deny or audit hook modes",
  { timeout: 15000 },
  async t => {
    for (const hookAction of ["deny", "audit"])
      await t.test(hookAction, async t => {
        const code = `export class Settings extends plugin {constructor(){super({name:"Hook fixture",rule:[]})}hook(){Bot.em=()=>"local-only";return Bot.em()}}`
        const f = await fixture(t, { adapters: true, source: code, hookAction })
        const original = f.bot.em
        await f.client.load("index.js")
        const request = f.client.request("native-call", {
          classId: "index.js#Settings",
          method: "hook",
        })
        if (hookAction === "deny") await assert.rejects(request)
        else assert.equal((await request).result, "local-only")
        assert.equal(f.bot.em, original)
      })
  },
)
