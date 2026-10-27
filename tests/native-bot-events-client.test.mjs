import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { fork } from "node:child_process"
import { EventEmitter } from "node:events"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"

// 使用真实客户端和 fork 子进程，仅替换系统启动和回收；不据此判定文件或网络隔离有效。
const repository = fileURLToPath(new URL("../", import.meta.url))
const moduleRoot = process.env.GUARD_TEST_MODULE_ROOT
  ? pathToFileURL(`${path.resolve(process.env.GUARD_TEST_MODULE_ROOT)}${path.sep}`)
  : new URL("../dist/", import.meta.url)
const { NativePluginClient } = await import(new URL("native-sandbox/client.js", moduleRoot))
const { parseSettings } = await import(new URL("config/index.js", moduleRoot))
const childEntry = fileURLToPath(new URL("native-sandbox/child.js", moduleRoot))
const runs = path.join(repository, "tests/runs")
const sha = value => createHash("sha256").update(value).digest("hex")
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const clone = value => JSON.parse(JSON.stringify(value))
function write(root, name, value) {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value, "utf8")
  return file
}
async function waitFor(predicate, description, timeout = 5000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await predicate()
    if (value) return value
    await pause(20)
  }
  throw new Error(description)
}

function businessSource(identity, gatedExit) {
  return `import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {EventEmitter} from "node:events"
const identity=${JSON.stringify(identity)}
const own=path.dirname(fileURLToPath(import.meta.url))
const state={identity,pid:process.pid,messages:[],once:[],removed:0,cleared:0,registered:[],exits:[],sdkReturns:0,failedOnceCalls:0}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const record=()=>fs.writeFileSync(path.join(own,"exit.json"),JSON.stringify(state))
let savedReply
async function message(event, marker){
  const row={raw:event.raw_message,user:event.user_id,marker:marker??null,thisIsBot:this===Bot,replyAvailable:typeof event.reply==="function"}
  state.messages.push(row)
  savedReply=event.reply
  if(event.delay)await pause(event.delay)
  if(event.reply)row.reply=await event.reply(identity+":"+event.raw_message)
  state.sdkReturns++
  const sdk=new EventEmitter();sdk.secret="callback-sdk-secret:"+identity
  return sdk
}
function removed(){state.removed++}
Bot.on("message.private",message)
Bot.on("remove.test",removed)
Bot.once("once.test",function(value){state.once.push({value,thisIsBot:this===Bot})})
function failedOnce(){state.failedOnceCalls++}
Bot.once("failed-once.test",failedOnce)
Bot.on("clear.test",function(){state.cleared++})
for(const kind of ["on","once"]){
  Bot[kind]("exit",async function(reason){
    state.exits.push({kind,phase:"start",reason,thisIsBot:this===Bot});record()
    ${gatedExit ? 'while(!fs.existsSync(path.join(own,"allow-exit")))await pause(20)' : "await pause(5)"}
    state.exits.push({kind,phase:"finished",reason,thisIsBot:this===Bot});record()
  })
}
export class Probe extends plugin {
  constructor(){super({name:"Benign Bot event fixture",rule:[]})}
  inspect(){return state}
  remove(){return Bot.off("remove.test",removed)===Bot}
  clearEvent(){return Bot.removeAllListeners("clear.test")===Bot}
  clearAll(){return Bot.removeAllListeners()===Bot}
  removeFailedOnce(){return Bot.off("failed-once.test",failedOnce)===Bot}
  register(event){const name=event.raw_message;return Bot.on(name,function(value){state.registered.push({name,value,thisIsBot:this===Bot});if(value==="throw")throw new Error("benign callback failure")})===Bot}
  async lateReply(){try{return {ok:true,result:await savedReply("expired-reply")}}catch(error){return {ok:false,code:error.code,message:error.message}}}
  forge(frame){process.send({type:"native-bot-events",frame});return true}
}
`
}

async function fixture(
  t,
  { ids = ["fixture-a"], rules = [], gatedExit = false, brokenOff = false, proxyBot = false } = {},
) {
  fs.mkdirSync(runs, { recursive: true })
  const root = fs.mkdtempSync(path.join(runs, "native-bot-events-client-"))
  t.diagnostic(`Real fork bridge evidence (OS substituted): ${root}`)
  const sourceHashes = new Map()
  const addSource = (name, value) =>
    sourceHashes.set(name, sha(fs.readFileSync(write(root, name, value))))
  addSource("package.json", '{"type":"module"}')
  addSource(
    "lib/plugins/plugin.js",
    "export default class plugin{constructor(options){Object.assign(this,options)}}",
  )
  for (const name of ["lodash", "oicq"]) {
    addSource(
      `node_modules/${name}/package.json`,
      JSON.stringify({ name, type: "module", main: "index.js" }),
    )
    addSource(
      `node_modules/${name}/index.js`,
      name === "lodash" ? "export default {}" : "export const segment={}",
    )
  }
  for (const id of ids) addSource(`plugins/${id}/index.js`, businessSource(id, gatedExit))
  const bot = new EventEmitter()
  bot.setMaxListeners(0)
  bot.bot = bot
  bot.uin = []
  bot.adapter = []
  bot.bots = {}
  const publicBot = proxyBot
    ? new Proxy(bot.bots, {
        get: (target, key) => bot[key] ?? target[key],
      })
    : bot
  let refuseOff = brokenOff
  bot.off = function (name, listener) {
    if (!refuseOff) EventEmitter.prototype.off.call(this, name, listener)
    return this
  }
  const originalBot = Object.getOwnPropertyDescriptor(globalThis, "Bot")
  Object.defineProperty(globalThis, "Bot", { configurable: true, writable: true, value: publicBot })
  const settings = parseSettings({
    rules,
    pluginSandbox: { native: { plugins: ids.map(id => ({ id, timeoutMs: 3000 })) } },
  })
  const sessions = []
  t.after(async () => {
    for (const id of ids) write(root, `plugins/${id}/allow-exit`, "test cleanup")
    const closing = await Promise.allSettled(sessions.map(session => session.client.close()))
    refuseOff = false
    for (const session of sessions) {
      // 断言保留记录后，修复故意失败的宿主回调清理。
      session.client.botEventsHost?.close()
      if (session.child.exitCode === null && session.child.signalCode === null) {
        const exited = new Promise(resolve => session.child.once("exit", resolve))
        session.child.kill()
        await exited
      }
      fs.writeFileSync(path.join(root, `child-${session.id}.log`), session.output, "utf8")
      write(
        root,
        `wire-${session.id}.json`,
        JSON.stringify({ outbound: session.outbound, inbound: session.messages }, null, 2) + "\n",
      )
    }
    if (originalBot) Object.defineProperty(globalThis, "Bot", originalBot)
    else delete globalThis.Bot
    const after = Object.fromEntries(
      [...sourceHashes].map(([file]) => [file, sha(fs.readFileSync(path.join(root, file)))]),
    )
    assert.deepEqual(
      after,
      Object.fromEntries(sourceHashes),
      "Generated business/core fixture sources remain byte-identical",
    )
    write(
      root,
      "report.json",
      JSON.stringify(
        {
          scope:
            "Real NativePluginClient and forked child IPC; injected handshaken OS session, no OS isolation claim",
          platform: process.platform,
          node: process.version,
          moduleRoot: fileURLToPath(moduleRoot),
          sourceHashesBefore: Object.fromEntries(sourceHashes),
          sourceHashesAfter: after,
          sessions: sessions.map((session, index) => ({
            id: session.id,
            childPid: session.child.pid,
            parentPid: process.pid,
            closeCalls: session.closeCalls,
            closeOutcome: closing[index].status,
            protocolErrors: session.protocolErrors.map(error => ({
              code: error.code,
              message: error.message,
            })),
            audit: session.audit,
            ...(session.proof ? { proof: session.proof } : {}),
          })),
        },
        null,
        2,
      ) + "\n",
    )
  })

  for (const id of ids) {
    const config = settings.pluginSandbox.native.plugins.find(plugin => plugin.id === id)
    const audit = [],
      messages = [],
      outbound = [],
      protocolErrors = []
    const client = new NativePluginClient(
      root,
      config,
      settings,
      event => audit.push(clone(event)),
      () => ({}),
    )
    const session = {
      id,
      client,
      audit,
      messages,
      outbound,
      protocolErrors,
      closeCalls: 0,
      output: "",
    }
    const child = fork(childEntry, [], {
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
    session.child = child
    sessions.push(session)
    child.stdout.on("data", data => {
      session.output += data
    })
    child.stderr.on("data", data => {
      session.output += data
    })
    const rawSend = child.send.bind(child)
    child.send = (frame, ...args) => {
      outbound.push(clone(frame))
      return rawSend(frame, ...args)
    }
    client.readyPromise = Promise.resolve()
    client.applicationReady = true
    client.session = {
      child,
      platform: process.platform,
      async close() {
        session.closeCalls++
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise(resolve => child.once("exit", resolve))
          child.kill()
          await exited
        }
      },
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Real child handshake timed out: " + session.output)),
        5000,
      )
      child.once("error", error => {
        clearTimeout(timer)
        reject(error)
      })
      child.on("message", frame => {
        messages.push(clone(frame))
        if (frame.type === "native-ready") {
          clearTimeout(timer)
          resolve()
          return
        }
        try {
          client.receive(frame)
        } catch (error) {
          protocolErrors.push(error)
          client.stop(error)
        }
      })
    })
    session.load = () => client.load("index.js")
    session.call = (method, event, args) =>
      client
        .request(
          "native-call",
          {
            classId: "index.js#Probe",
            method,
            ...(args === undefined ? {} : { args }),
          },
          event,
        )
        .then(value => value.result)
    session.inspect = () => session.call("inspect")
  }
  return {
    root,
    bot,
    publicBot,
    sessions,
    settings,
    repairOff: () => {
      refuseOff = false
    },
  }
}

test(
  "real fork sessions receive separate callbacks with Bot this and request-bound reply capabilities",
  { timeout: 20000 },
  async t => {
    const f = await fixture(t, { ids: ["fixture-a", "fixture-b"] })
    const replies = []
    for (const session of f.sessions) {
      const loaded = await session.load()
      assert.equal(loaded.classes.length, 1)
      assert.equal(loaded.pid, session.child.pid)
      assert.notEqual(loaded.pid, process.pid)
    }
    const events = ["first", "second"].map((name, index) => ({
      raw_message: name,
      user_id: `user-${name}`,
      delay: index ? 0 : 50,
      async reply(message) {
        assert.equal(this, events[index])
        replies.push({ name, message })
        return { message_id: `reply-${name}` }
      },
    }))
    for (const event of events)
      assert.doesNotThrow(() => f.bot.emit("message.private", event, "extra-argument"))
    await waitFor(
      () => replies.length === 4,
      "Both child sessions must reply to both original events",
    )
    for (const session of f.sessions) {
      const state = await waitFor(async () => {
        const value = await session.inspect()
        return value.sdkReturns === 2 && value
      }, "Callback completion missing")
      assert.equal(state.pid, session.child.pid)
      assert.deepEqual(
        state.messages.map(row => [
          row.raw,
          row.user,
          row.marker,
          row.thisIsBot,
          row.replyAvailable,
        ]),
        [
          ["first", "user-first", "extra-argument", true, true],
          ["second", "user-second", "extra-argument", true, true],
        ],
      )
      assert.deepEqual(
        state.messages.map(row => row.reply.message_id),
        ["reply-first", "reply-second"],
      )
      assert.deepEqual(
        replies
          .filter(row => row.message.startsWith(session.id + ":"))
          .map(row => row.name)
          .sort(),
        ["first", "second"],
      )
      const late = await session.call("lateReply")
      assert.equal(late.ok, false)
      assert.match(late.message, /事件能力缺失或已过期/)
      assert.ok(
        session.audit.some(
          event => event.operation === "native.service-error" && event.target === "event.reply",
        ),
      )
      const deliveries = session.outbound.filter(frame => frame.type === "native-bot-event")
      assert.equal(deliveries.length, 2)
      for (const frame of deliveries) {
        const result = session.messages.find(
          message => message.type === "native-result" && message.requestId === frame.requestId,
        )
        assert.equal(result.ok, true)
        assert.equal(result.value, null, "Callback SDK return values must not be serialized")
        assert.equal(frame.args[0].reply, undefined)
      }
      assert.doesNotMatch(JSON.stringify(session.messages), /callback-sdk-secret/)
      assert.deepEqual(session.protocolErrors, [])
    }
    assert.equal(
      replies.length,
      4,
      "Expired callback replies cannot borrow a newer native-call request",
    )
  },
)

test(
  "online/connect and nested Bot/account payloads never serialize host-owned secrets",
  { timeout: 15000 },
  async t => {
    const f = await fixture(t, { proxyBot: true }),
      [session] = f.sessions
    const secret = "dummy-host-account-secret-canary-20261024"
    const account = { uin: "public-account", info: { token: secret }, sdk: { password: secret } }
    f.bot.uin.push("public-account")
    f.bot.bots["public-account"] = account
    f.bot.info = { token: secret }
    await session.load()
    for (const name of ["online", "connect.public-account", "object.test"])
      assert.equal(await session.call("register", { raw_message: name }), true)
    f.bot.emit("online", f.publicBot)
    f.bot.emit("connect.public-account", f.bot)
    f.bot.emit("connect.public-account", account)
    f.bot.emit("object.test", f.publicBot)
    f.bot.emit("object.test", account)
    f.bot.emit("object.test", { safe: "ordinary-value", nested: { Bot: f.publicBot, account } })
    const state = await waitFor(async () => {
      const value = await session.inspect()
      return value.registered.length === 6 && value
    }, "Host metadata projection must still deliver usable event DTOs")
    for (const row of state.registered.slice(0, 3))
      assert.deepEqual(row.value, { uin: ["public-account"] })
    assert.equal(state.registered[3].value, null)
    assert.equal(state.registered[4].value, null)
    assert.deepEqual(state.registered[5].value, { safe: "ordinary-value", nested: {} })
    const outgoing = session.outbound.filter(frame => frame.type === "native-bot-event")
    assert.equal(outgoing.length, 6)
    assert.ok(
      outgoing.every(frame => !Object.hasOwn(frame, "event")),
      "Original host event remains in the authority map and never enters event IPC",
    )
    assert.doesNotMatch(JSON.stringify(session.outbound), new RegExp(secret))
    assert.doesNotMatch(JSON.stringify(session.messages), new RegExp(secret))
    assert.deepEqual(session.protocolErrors, [])
  },
)

test(
  "real child off, once and clear preserve core and peer listeners",
  { timeout: 20000 },
  async t => {
    const f = await fixture(t, { ids: ["fixture-a", "fixture-b"] })
    const [one, two] = f.sessions
    await one.load()
    await two.load()
    let core = 0
    const coreListener = () => core++
    f.bot.on("remove.test", coreListener)
    assert.equal(await one.call("remove"), true)
    f.bot.emit("remove.test")
    f.bot.emit("once.test", "first")
    f.bot.emit("once.test", "second")
    assert.equal(await one.call("clearEvent"), true)
    f.bot.emit("clear.test")
    const peer = await waitFor(async () => {
      const value = await two.inspect()
      return value.removed === 1 && value.cleared === 1 && value.once.length === 1 && value
    }, "Peer callbacks were removed")
    const own = await one.inspect()
    assert.equal(own.removed, 0)
    assert.equal(own.cleared, 0)
    assert.deepEqual(own.once, [{ value: "first", thisIsBot: true }])
    assert.deepEqual(peer.once, [{ value: "first", thisIsBot: true }])
    assert.equal(core, 1)
    assert.ok(f.bot.listeners("remove.test").includes(coreListener))
    assert.equal(await one.call("clearAll"), true)
    assert.equal(one.client.botEventsHost.stats.listeners, 0)
    assert.ok(two.client.botEventsHost.stats.listeners > 0)
    f.bot.emit("remove.test")
    await waitFor(
      async () => (await two.inspect()).removed === 2,
      "Peer listener must survive another session's removeAllListeners",
    )
    assert.equal(core, 2)
    assert.deepEqual(one.protocolErrors, [])
    assert.deepEqual(two.protocolErrors, [])
  },
)

test(
  "real core-shaped rawListeners exit waits for child cleanup and dispose never invokes it twice",
  { timeout: 20000 },
  async t => {
    const f = await fixture(t, { gatedExit: true }),
      [session] = f.sessions
    await session.load()
    let settled = false
    const exiting = Promise.all(
      f.bot
        .rawListeners("exit")
        .map(listener => Promise.resolve().then(() => listener.call(f.bot, "host-exit"))),
    ).then(() => {
      settled = true
    })
    const started = await waitFor(async () => {
      const state = await session.inspect()
      return state.exits.filter(row => row.phase === "start").length === 2 && state
    }, "Both guest exit callbacks must start")
    assert.equal(settled, false)
    assert.ok(started.exits.every(row => row.thisIsBot && row.reason === "host-exit"))
    let closeSettled = false
    const closing = session.client.close().then(() => {
      closeSettled = true
    })
    await waitFor(
      () => session.outbound.some(frame => frame.type === "native-dispose"),
      "Client disposal must have reached the child",
    )
    await pause(50)
    assert.equal(closeSettled, false, "Disposal must await already-running on/once exit cleanup")
    assert.equal(session.closeCalls, 0, "OS teardown must not race past exit cleanup")
    write(f.root, `plugins/${session.id}/allow-exit`, "release real child cleanup")
    await Promise.all([exiting, closing])
    assert.equal(settled, true)
    const proof = JSON.parse(
      fs.readFileSync(path.join(f.root, `plugins/${session.id}/exit.json`), "utf8"),
    )
    assert.deepEqual(proof.exits.map(row => `${row.kind}:${row.phase}`).sort(), [
      "on:finished",
      "on:start",
      "once:finished",
      "once:start",
    ])
    assert.ok(proof.exits.every(row => row.reason === "host-exit"))
    assert.equal(session.closeCalls, 1)
    assert.equal(session.client.botEventsHost.stats.listeners, 0)
  },
)

test(
  "real client always tears down its OS session after listener cleanup failure and retains the ledger",
  { timeout: 15000 },
  async t => {
    const f = await fixture(t, { brokenOff: true }),
      [session] = f.sessions
    await session.load()
    const before = session.client.botEventsHost.stats.listeners
    await assert.rejects(session.client.close(), { code: "BOT_EVENT_CLEANUP_UNCONFIRMED" })
    assert.equal(
      session.closeCalls,
      1,
      "OS session teardown must run even when host listener removal fails",
    )
    assert.notEqual(session.child.exitCode === null && session.child.signalCode === null, true)
    assert.equal(session.client.botEventsHost.stats.listeners, before)
    assert.equal(session.client.botEventsHost.stats.closed, true)
    session.proof = {
      retainedListeners: before,
      closed: true,
      osCloseCalls: session.closeCalls,
      childExited: session.child.exitCode !== null || session.child.signalCode !== null,
    }
    assert.ok(
      session.audit.some(
        event =>
          event.operation === "native.registration-cleanup-unconfirmed" &&
          event.action === "restart",
      ),
    )
    assert.ok(
      session.audit.some(
        event => event.operation === "native.process-closed" && event.details.confirmed,
      ),
    )
    f.repairOff()
    session.client.botEventsHost.close()
    assert.equal(session.client.botEventsHost.stats.listeners, 0)
  },
)

test(
  "global Bot subscription deny blocks only the selected event target",
  { timeout: 15000 },
  async t => {
    const f = await fixture(t, {
      rules: [
        {
          id: "global-bot-deny",
          kind: "plugin-sandbox",
          operation: "native.bot.on",
          target: "blocked.test",
          action: "deny",
        },
      ],
    })
    const [session] = f.sessions
    await session.load()
    assert.equal(await session.call("register", { raw_message: "allowed.test" }), true)
    assert.equal(f.bot.listenerCount("allowed.test"), 1)
    await assert.rejects(
      session.call("register", { raw_message: "blocked.test" }),
      /blocked native.bot.on/,
    )
    assert.equal(f.bot.listenerCount("blocked.test"), 0)
    assert.ok(
      session.audit.some(
        event =>
          event.operation === "native.bot.on" &&
          event.target === "blocked.test" &&
          event.action === "deny" &&
          event.ruleId === "global-bot-deny",
      ),
    )
    await waitFor(
      () => session.closeCalls === 1,
      "Denied registration must revoke its failing client",
    )
  },
)

test(
  "per-plugin Bot subscription deny leaves peer and unmatched target usable",
  { timeout: 20000 },
  async t => {
    const f = await fixture(t, {
      ids: ["fixture-a", "fixture-b"],
      rules: [
        {
          id: "one-bot-deny",
          plugin: "fixture-a",
          operation: "native.bot.on",
          target: "blocked.test",
          action: "deny",
        },
      ],
    })
    const [one, two] = f.sessions
    await one.load()
    await two.load()
    assert.equal(await one.call("register", { raw_message: "allowed.test" }), true)
    assert.equal(await two.call("register", { raw_message: "blocked.test" }), true)
    await assert.rejects(
      one.call("register", { raw_message: "blocked.test" }),
      /blocked native.bot.on/,
    )
    f.bot.emit("blocked.test", "peer-still-live")
    const state = await waitFor(async () => {
      const value = await two.inspect()
      return value.registered.length && value
    }, "Scoped deny must preserve the peer's matching event")
    assert.deepEqual(state.registered, [
      { name: "blocked.test", value: "peer-still-live", thisIsBot: true },
    ])
    assert.equal(two.closeCalls, 0)
    assert.deepEqual(two.protocolErrors, [])
  },
)

test(
  "first-match audit overrides a later global subscription deny without extra OS grants",
  { timeout: 15000 },
  async t => {
    const f = await fixture(t, {
      rules: [
        {
          id: "earlier-audit",
          plugin: "fixture-a",
          operation: "native.bot.on",
          target: "blocked.test",
          action: "audit",
        },
        { id: "later-deny", operation: "native.bot.on", target: "blocked.test", action: "deny" },
      ],
    })
    const [session] = f.sessions
    await session.load()
    assert.equal(await session.call("register", { raw_message: "blocked.test" }), true)
    f.bot.emit("blocked.test", "allowed-by-first-rule")
    await waitFor(
      async () => (await session.inspect()).registered.length === 1,
      "Earlier audit subscription should work",
    )
    assert.ok(
      session.audit.some(
        event =>
          event.operation === "native.bot.on" &&
          event.target === "blocked.test" &&
          event.ruleId === "earlier-audit" &&
          event.action === "audit",
      ),
    )
    assert.deepEqual(session.client.config.writablePaths, [])
    assert.deepEqual(session.client.config.writableFiles, [])
    assert.equal(session.client.config.adapters, false)
    assert.equal(session.client.config.network, "none")
    assert.equal(session.client.config.allowCoreRestart, false)
    assert.deepEqual(session.client.config.redis, { read: [], write: [] })
  },
)

test(
  "real callback failure is audited without throwing through core or stopping later events",
  { timeout: 15000 },
  async t => {
    const f = await fixture(t),
      [session] = f.sessions
    await session.load()
    assert.equal(await session.call("register", { raw_message: "failure.test" }), true)
    let core = 0
    f.bot.on("failure.test", () => core++)
    assert.doesNotThrow(() => f.bot.emit("failure.test", "throw"))
    await waitFor(
      () => session.audit.some(event => event.operation === "native.bot.delivery-error"),
      "Callback error must reach the host audit",
    )
    assert.doesNotThrow(() => f.bot.emit("failure.test", "safe"))
    const state = await waitFor(async () => {
      const value = await session.inspect()
      return value.registered.length === 2 && value
    }, "The same callback must remain usable after a rejected delivery")
    assert.deepEqual(
      state.registered.map(row => row.value),
      ["throw", "safe"],
    )
    assert.equal(core, 2)
    assert.equal(session.closeCalls, 0)
    assert.deepEqual(session.protocolErrors, [])
  },
)

test(
  "real once DTO failure allows a later off without retiring the whole client",
  { timeout: 15000 },
  async t => {
    const f = await fixture(t),
      [session] = f.sessions
    await session.load()
    assert.doesNotThrow(() => f.bot.emit("failed-once.test", { large: "x".repeat(65537) }))
    await waitFor(
      () => session.audit.some(event => event.operation === "native.bot.delivery-error"),
      "Oversize once DTO must be audited",
    )
    assert.equal(session.client.botEventsHost.stats.retiredOnce, 1)
    assert.equal(await session.call("removeFailedOnce"), true)
    assert.equal(session.client.botEventsHost.stats.retiredOnce, 0)
    assert.equal((await session.inspect()).failedOnceCalls, 0)
    assert.equal(session.closeCalls, 0)
    assert.deepEqual(session.protocolErrors, [])
  },
)

test(
  "real child session/handle forgeries cannot invoke or revoke peer callbacks",
  { timeout: 30000 },
  async t => {
    for (const field of ["session", "handle"])
      await t.test(field, async t => {
        const f = await fixture(t, { ids: ["fixture-a", "fixture-b"] }),
          [one, two] = f.sessions
        await one.load()
        await two.load()
        const foreign = two.messages.find(
          frame => frame.type === "native-bot-events" && frame.frame.type === "subscribe",
        ).frame
        await assert.rejects(
          one.client.request("native-bot-event", {
            handle: foreign.id,
            args: [{ raw_message: "forged" }],
            eventReply: false,
          }),
          /another session/,
        )
        assert.equal((await two.inspect()).messages.length, 0)
        const ownFrames = one.messages.filter(frame => frame.type === "native-bot-events")
        const frame = {
          type: "unsubscribe",
          sessionId: field === "session" ? foreign.sessionId : one.client.botEventsHost.sessionId,
          sequence: ownFrames.at(-1).frame.sequence + 1,
          id: foreign.id,
        }
        await assert.rejects(one.call("forge", undefined, [frame]), /another session/)
        assert.equal(
          one.protocolErrors.at(-1).code,
          field === "session" ? "BOT_EVENT_FOREIGN_SESSION" : "BOT_EVENT_FOREIGN_HANDLE",
        )
        f.bot.emit("message.private", { raw_message: "peer-safe", user_id: "peer" })
        const peer = await waitFor(async () => {
          const value = await two.inspect()
          return value.messages.length && value
        }, "Peer listener must survive a foreign unsubscribe")
        assert.equal(peer.messages[0].raw, "peer-safe")
        assert.equal(two.closeCalls, 0)
        assert.deepEqual(two.protocolErrors, [])
      })
  },
)
