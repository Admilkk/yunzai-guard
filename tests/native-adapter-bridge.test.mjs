import assert from "node:assert/strict"
import test from "node:test"
import { NativeAdapterGuest } from "../dist/native-sandbox/adapter-guest.js"
import { NativeAdapterHost } from "../dist/native-sandbox/adapter-host.js"
import { validateAdapterFrame, adapterDto } from "../dist/native-sandbox/adapter-protocol.js"

const clone = value => JSON.parse(JSON.stringify(value))
function hostBot() {
  return {
    adapter: [],
    uin: [],
    events: [],
    em(name, event) {
      // 受信宿主按核心同步 pick/prepareEvent 契约构建。
      if (event.user_id) event.friend = event.bot.pickFriend(event.user_id)
      if (event.group_id) {
        event.group = event.bot.pickGroup(event.group_id)
        if (event.user_id) event.member = event.group.pickMember(event.user_id)
      }
      if (event.group) event.reply = event.group.sendMsg.bind(event.group)
      else if (event.friend) event.reply = event.friend.sendMsg.bind(event.friend)
      if (name.startsWith("connect.") && !this.uin.includes(event.self_id))
        this.uin.push(event.self_id)
      this.events.push({ name, event })
    },
    restart() {
      throw new Error("Host restart must never be invoked")
    },
  }
}

function fixture(t, bot = hostBot(), pluginId = "adapter-one") {
  const frames = [],
    calls = []
  let guest
  const host = new NativeAdapterHost({
    pluginId,
    bot,
    invoke: async call => {
      calls.push(clone(call))
      return clone(await guest.invoke(clone(call)))
    },
  })
  guest = new NativeAdapterGuest(frame => {
    frames.push(clone(frame))
    host.receive(clone(frame))
  })
  const Bot = new Proxy(
    { adapter: guest.adapter, em: guest.emit.bind(guest) },
    {
      get: (target, key) => (Object.hasOwn(target, key) ? target[key] : guest.getAccount(key)),
      set: (target, key, value) => {
        if (Object.hasOwn(target, key))
          throw new Error("Fixture denies hook of its Bot entrypoints")
        guest.setAccount(key, value)
        return true
      },
    },
  )
  t.after(async () => {
    host.close()
    await guest.dispose()
  })
  return { bot, Bot, host, guest, frames, calls }
}

function install(Bot, { id = "ko_fixture", adapterId = "fixture-adapter", failLoad = false } = {}) {
  const effects = { loads: 0, sends: [], getters: 0, logouts: 0 }
  const entity = (kind, target) => ({
    info: { nickname: `${kind}-${target}`, secret: "must-stay-in-guest" },
    sendMsg: async message => {
      effects.sends.push({ kind, target, message })
      return { message_id: `${kind}-${effects.sends.length}` }
    },
    recallMsg: async messageId => `recalled:${messageId}`,
    getInfo() {
      return this.info
    },
    getAvatarUrl: async () => "https://example.invalid/avatar",
    pickMember: userId => entity("member", `${target}/${userId}`),
  })
  // 保留既有适配器接口形态：push、异步 load、SDK 包装、getter、Map 元数据、同步 pick 和 Bot.em。
  const adapter = new (class {
    id = adapterId
    name = "Benign adapter fixture"
    version = "fixture-1"
    async load() {
      effects.loads++
      await Promise.resolve()
      if (failLoad) throw new Error("Original SDK login failed")
      Bot[id] = {
        adapter: this,
        sdk: { token: "must-stay-in-guest", transport: { live: true } },
        info: { id, username: "guest-account", secret: "must-stay-in-guest" },
        get nickname() {
          effects.getters++
          return this.info.username
        },
        uin: id,
        version: { id: this.id, name: this.name, version: this.version },
        stat: { start_time: 123 },
        fl: new Map([
          ["user-1", { user_id: "user-1", nickname: "friend-name", token: "must-stay-in-guest" }],
        ]),
        gl: new Map([["group-1", { group_id: "group-1", group_name: "group-name" }]]),
        gml: new Map([
          ["group-1", new Map([["user-1", { user_id: "user-1", card: "member-card" }]])],
        ]),
        pickFriend: userId => entity("friend", userId),
        get pickUser() {
          return this.pickFriend
        },
        pickGroup: groupId => entity("group", groupId),
        pickMember: (groupId, userId) => entity("member", `${groupId}/${userId}`),
        getFriendMap() {
          return this.fl
        },
        getGroupMemberMap() {
          return this.gml
        },
        async logout() {
          effects.logouts++
        },
      }
      Bot.em(`connect.${id}`, { self_id: id })
      return true
    }
  })()
  assert.equal(Bot.adapter.push(adapter), 1)
  return { adapter, effects, id }
}

test("registration preserves the original API and host load invokes and awaits the real guest load", async t => {
  const f = fixture(t),
    installed = install(f.Bot)
  assert.equal(installed.effects.loads, 0, "Static registration is not a load result")
  assert.equal(f.bot.adapter.length, 1)
  assert.notEqual(f.bot.adapter[0], installed.adapter)
  assert.equal(await f.bot.adapter[0].load(), true)
  assert.equal(installed.effects.loads, 1)
  assert.equal(f.bot.uin[0], installed.id)
  assert.equal(f.bot[installed.id].nickname, "guest-account")
  assert.equal(f.bot[installed.id].sdk, undefined)
  assert.notEqual(f.bot[installed.id], f.Bot[installed.id])
  assert.ok(installed.effects.getters > 0)
  assert.doesNotMatch(JSON.stringify(f.frames), /must-stay-in-guest|"sdk"|"secret"|"token"/)
  for (const frame of f.frames) assert.doesNotThrow(() => adapterDto(frame))
})

test("real load failure remains a rejection and never creates an accepted account", async t => {
  const f = fixture(t),
    installed = install(f.Bot, { failLoad: true })
  await assert.rejects(f.bot.adapter[0].load(), /Original SDK login failed/)
  assert.equal(installed.effects.loads, 1)
  assert.equal(f.bot[installed.id], undefined)
  assert.deepEqual(f.bot.uin, [])
})

test("guest connectedIds follows connect, disconnect, removal and disposal within its own session", async t => {
  const f = fixture(t),
    installed = install(f.Bot)
  const reference = f.guest.connectedIds
  await f.bot.adapter[0].load()
  assert.deepEqual(reference, [installed.id])
  f.Bot.em(`connect.${installed.id}`, { self_id: installed.id })
  assert.deepEqual(reference, [installed.id])
  f.Bot.em(`disconnect.${installed.id}`, { self_id: installed.id })
  assert.deepEqual(reference, [])
  f.Bot.em(`connect.${installed.id}`, { self_id: installed.id })
  f.guest.removeAccount(installed.id)
  assert.deepEqual(reference, [])
  await f.bot.adapter[0].load()
  assert.deepEqual(reference, [installed.id])
  await f.guest.dispose()
  assert.deepEqual(reference, [])
})

test("TRSS-shaped Proxy publishes accounts to bots and refuses core utility fallback shadows", async t => {
  const core = hostBot()
  core.bots = {}
  core.bot = core
  const utility = {
    Buffer() {
      return "trusted utility"
    },
  }
  // 目标与 get 优先级和真实 lib/bot.js 构造器一致。
  const Bot = new Proxy(core.bots, {
    get: (target, property) => core[property] ?? utility[property] ?? target[property],
  })
  const f = fixture(t, Bot),
    installed = install(f.Bot)
  await Bot.adapter[0].load()
  assert.equal(Object.hasOwn(core, installed.id), false)
  assert.equal(Object.hasOwn(core.bots, installed.id), true)
  assert.equal(Bot[installed.id], core.bots[installed.id])
  const snapshot = f.frames.findLast(frame => frame.type === "account")
  assert.throws(
    () =>
      f.host.receive({
        type: "account",
        account: {
          ...snapshot.account,
          id: "Buffer",
          handle: "account-00000000-0000-0000-0000-000000000000",
        },
      }),
    { code: "ADAPTER_ACCOUNT_DENIED" },
  )
  assert.equal(Bot.Buffer, utility.Buffer)
  assert.equal(Object.hasOwn(core.bots, "Buffer"), false)
  f.host.close()
  assert.equal(Object.hasOwn(core.bots, installed.id), false)
})

test("pickFriend/pickGroup/pickMember are synchronous facades and sends use asynchronous capability RPC", async t => {
  const f = fixture(t),
    installed = install(f.Bot)
  await f.bot.adapter[0].load()
  const account = f.bot[installed.id],
    before = f.calls.length
  const friend = account.pickFriend("user-1")
  const group = account.pickGroup("group-1")
  const member = group.pickMember("user-1")
  assert.equal(friend.then, undefined)
  assert.equal(group.then, undefined)
  assert.equal(member.then, undefined)
  assert.equal(f.calls.length, before, "Selecting a facade does not synchronously perform RPC")
  assert.equal(friend.nickname, "friend-name")
  assert.equal(group.group_name, "group-name")
  assert.equal(member.card, "member-card")
  assert.equal(account.fl.get("user-1").nickname, "friend-name")
  assert.equal(account.gml.get("group-1").get("user-1").card, "member-card")
  const sending = member.sendMsg("hello")
  assert.ok(sending instanceof Promise)
  assert.equal((await sending).message_id, "member-1")
  assert.deepEqual(installed.effects.sends, [
    { kind: "member", target: "group-1/user-1", message: "hello" },
  ])
  assert.deepEqual(clone(await friend.getInfo()), { nickname: "friend-user-1" })
  assert.equal((await account.getFriendMap()).get("user-1").nickname, "friend-name")
  assert.equal((await account.getGroupMemberMap()).get("group-1").get("user-1").card, "member-card")
})

test("account events exclude guest capabilities and permission flags while host rebuilds reply", async t => {
  const f = fixture(t),
    installed = install(f.Bot)
  await f.bot.adapter[0].load()
  f.Bot.em("message.group", {
    self_id: installed.id,
    user_id: "user-1",
    group_id: "group-1",
    post_type: "message",
    message_type: "group",
    message: [{ type: "text", text: "hello" }],
    raw_message: "hello",
    sender: { nickname: "sender", isMaster: true },
    bot: f.Bot[installed.id],
    reply() {
      throw new Error("Guest callback must never enter host")
    },
    isMaster: true,
    is_owner: true,
  })
  const incoming = f.bot.events.at(-1).event
  assert.equal(incoming.bot, f.bot[installed.id])
  assert.equal(incoming.friend.nickname, "friend-name")
  assert.equal(incoming.isMaster, undefined)
  assert.equal(incoming.is_owner, undefined)
  assert.equal(incoming.sender.isMaster, undefined)
  assert.equal((await incoming.reply("host response")).message_id, "group-1")
  const frame = f.frames.findLast(frame => frame.type === "event")
  assert.equal(Object.hasOwn(frame.event, "reply"), false)
  for (const flag of ["isMaster", "is_owner", "isAdmin"])
    assert.throws(() => f.host.receive({ ...frame, event: { ...frame.event, [flag]: true } }), {
      code: "ADAPTER_EVENT_DENIED",
    })
  assert.throws(() =>
    f.host.receive({ ...frame, event: { ...frame.event, sender: { isMaster: true } } }),
  )
  assert.throws(
    () => f.host.receive({ ...frame, event: { ...frame.event, self_id: "somebody-else" } }),
    { code: "ADAPTER_EVENT_DENIED" },
  )
  assert.throws(() => f.host.receive({ ...frame, name: "exit" }), { code: "ADAPTER_EVENT_DENIED" })
})

test("another session cannot claim an account, emit its events or remove its host proxy", async t => {
  const bot = hostBot(),
    first = fixture(t, bot, "one"),
    second = fixture(t, bot, "two")
  const a = install(first.Bot, { adapterId: "QQ" })
  install(second.Bot, { adapterId: "QQ", id: a.id })
  await bot.adapter[0].load()
  const original = bot[a.id]
  await assert.rejects(bot.adapter[1].load(), { code: "ADAPTER_ACCOUNT_DENIED" })
  const foreignEvent = first.frames.findLast(frame => frame.type === "event")
  assert.throws(() => second.host.receive(foreignEvent), { code: "ADAPTER_EVENT_DENIED" })
  second.host.receive({ type: "remove", accountHandle: foreignEvent.accountHandle })
  second.host.close()
  assert.equal(bot[a.id], original)
  assert.deepEqual(bot.uin, [a.id])
  assert.equal(bot.adapter.length, 1)
})

test("protocol family IDs can coexist while facade, account and cleanup ownership stay session scoped", async t => {
  const bot = hostBot()
  const builtin = { id: "QQ", name: "OneBotv11", load: async () => true }
  bot.adapter.push(builtin)
  const first = fixture(t, bot, "native-one"),
    second = fixture(t, bot, "native-two")
  const a = install(first.Bot, { adapterId: "QQ", id: "account_one" })
  const b = install(second.Bot, { adapterId: "QQ", id: "account_two" })
  const firstFacade = bot.adapter[1],
    secondFacade = bot.adapter[2]
  assert.deepEqual(
    bot.adapter.map(adapter => adapter.id),
    ["QQ", "QQ", "QQ"],
  )
  assert.notEqual(firstFacade, secondFacade)
  assert.match(firstFacade.path, /^native:native-one:/)
  assert.match(secondFacade.path, /^native:native-two:/)
  await Promise.all([firstFacade.load(), secondFacade.load()])
  const peerAccount = bot[b.id]
  assert.equal(bot[a.id].adapter, firstFacade)
  assert.equal(peerAccount.adapter, secondFacade)
  const firstRegistration = first.frames.find(frame => frame.type === "register")
  assert.throws(() => first.host.receive(firstRegistration), {
    code: "ADAPTER_REGISTRATION_DENIED",
  })
  await assert.rejects(
    second.guest.invoke({ methodHandle: firstRegistration.adapter.loadHandle, args: [] }),
    { code: "ADAPTER_UNKNOWN_METHOD" },
  )
  first.host.close()
  assert.deepEqual(bot.adapter, [builtin, secondFacade])
  assert.equal(bot[a.id], undefined)
  assert.equal(bot[b.id], peerAccount)
  assert.deepEqual(bot.uin, [b.id])
  const sent = await peerAccount.pickFriend("user-1").sendMsg("peer remains active")
  assert.equal(sent.message_id, "friend-1")
  assert.deepEqual(b.effects.sends, [
    { kind: "friend", target: "user-1", message: "peer remains active" },
  ])
  second.host.close()
  assert.deepEqual(bot.adapter, [builtin])
  assert.deepEqual(bot.uin, [])
  assert.equal(bot[b.id], undefined)
})

test("malformed message shapes and routing fields never reach the core event dispatcher", async t => {
  const f = fixture(t),
    installed = install(f.Bot)
  await f.bot.adapter[0].load()
  f.Bot.em("message.group", {
    self_id: installed.id,
    user_id: "user-1",
    group_id: "group-1",
    post_type: "message",
    message_type: "group",
    message: [{ type: "text", text: "valid" }],
  })
  const frame = f.frames.findLast(frame => frame.type === "event")
  const count = f.bot.events.length
  for (const changed of [
    { message: {} },
    { message: [null] },
    { message: [{}] },
    { message: [{ type: {} }] },
    { message: [{ type: "text", text: {} }] },
    { message: Array.from({ length: 129 }, () => ({ type: "text", text: "x" })) },
    { raw_message: {} },
    { user_id: {} },
    { sender: "invalid" },
    { post_type: "notice" },
    { message_type: "private" },
    { sub_type: {} },
    { time: "yesterday" },
    { message_id: {} },
  ])
    assert.throws(() => f.host.receive({ ...frame, event: { ...frame.event, ...changed } }))
  assert.throws(() =>
    f.host.receive({ ...frame, name: "message.group.normal", event: frame.event }),
  )
  assert.equal(f.bot.events.length, count)
})

test("core Bot properties and existing ordinary accounts cannot be overwritten", async t => {
  const bot = hostBot(),
    existing = { ordinary: true }
  bot.preexisting = existing
  const f = fixture(t, bot)
  const originalRestart = bot.restart,
    originalEm = bot.em
  assert.throws(() => f.guest.setAccount("restart", {}), { code: "ADAPTER_ACCOUNT_DENIED" })
  assert.throws(() => f.guest.setAccount("__proto__", {}))
  install(f.Bot, { id: "preexisting" })
  await assert.rejects(bot.adapter[0].load(), { code: "ADAPTER_ACCOUNT_DENIED" })
  assert.equal(bot.preexisting, existing)
  assert.equal(bot.restart, originalRestart)
  assert.equal(bot.em, originalEm)
})

test("unknown, forged, cross-target and revoked method handles never dispatch", async t => {
  const f = fixture(t),
    installed = install(f.Bot)
  await f.bot.adapter[0].load()
  const registration = f.frames.find(frame => frame.type === "register").adapter
  const account = f.frames.findLast(frame => frame.type === "account").account
  await assert.rejects(
    f.guest.invoke({ methodHandle: "method-00000000-0000-0000-0000-000000000000", args: [] }),
    { code: "ADAPTER_UNKNOWN_METHOD" },
  )
  await assert.rejects(
    f.guest.invoke({
      methodHandle: registration.loadHandle,
      args: [],
      selector: { kind: "friend", userId: "user-1" },
    }),
    { code: "ADAPTER_INVALID_SELECTOR" },
  )
  await assert.rejects(
    f.guest.invoke({ methodHandle: account.entityMethods.sendMsg, args: ["invalid"] }),
    { code: "ADAPTER_INVALID_SELECTOR" },
  )
  await assert.rejects(
    f.guest.invoke({
      methodHandle: account.entityMethods.sendMsg,
      args: ["invalid"],
      selector: { kind: "constructor", userId: "user-1" },
    }),
    { code: "ADAPTER_INVALID_SELECTOR" },
  )
  f.guest.removeAccount(installed.id)
  await assert.rejects(
    f.guest.invoke({
      methodHandle: account.entityMethods.sendMsg,
      args: ["old"],
      selector: { kind: "friend", userId: "user-1" },
    }),
    { code: "ADAPTER_UNKNOWN_METHOD" },
  )
  assert.equal(f.bot[installed.id], undefined)
  assert.deepEqual(f.bot.uin, [])
})

test("session close revokes pending calls and retained facades and disposes the real guest SDK", async t => {
  const f = fixture(t),
    installed = install(f.Bot)
  await f.bot.adapter[0].load()
  const retained = f.bot[installed.id].pickFriend("user-1")
  let complete
  f.Bot[installed.id].pickFriend = () => ({
    sendMsg: () =>
      new Promise(resolve => {
        complete = resolve
      }),
  })
  const pending = retained.sendMsg("pending")
  const denied = assert.rejects(pending, /独立适配器会话已关闭/)
  f.host.close()
  await denied
  await assert.rejects(retained.sendMsg("after-close"), { code: "ADAPTER_CLOSED" })
  assert.equal(f.bot[installed.id], undefined)
  assert.deepEqual(f.bot.adapter, [])
  assert.deepEqual(f.bot.uin, [])
  complete("late result")
  const disposed = await f.guest.dispose()
  assert.equal(disposed.accounts, 1)
  assert.equal(installed.effects.logouts, 1)
})

test("cleanup continues after one account deletion fails and preserves that ownership for retry", async t => {
  const target = hostBot()
  let refuseDelete = true
  const bot = new Proxy(target, {
    deleteProperty(object, key) {
      return key === "ko_fixture" && refuseDelete ? false : Reflect.deleteProperty(object, key)
    },
  })
  const f = fixture(t, bot),
    installed = install(f.Bot)
  await bot.adapter[0].load()
  f.guest.setAccount("second_account", { ...f.Bot[installed.id], uin: "second_account" })
  f.Bot.em("connect.second_account", { self_id: "second_account" })
  const first = bot[installed.id]
  assert.throws(() => f.host.close(), AggregateError)
  assert.equal(bot[installed.id], first)
  assert.equal(bot.second_account, undefined)
  assert.deepEqual(bot.adapter, [])
  assert.deepEqual(bot.uin, [installed.id])
  assert.throws(() => first.pickFriend("user-1"), { code: "ADAPTER_CLOSED" })
  refuseDelete = false
  assert.doesNotThrow(() => f.host.close())
  assert.equal(bot[installed.id], undefined)
  assert.deepEqual(bot.uin, [])
})

test("partial cleanup retains a failed uin removal after its account property was already deleted", async t => {
  const bot = hostBot()
  let refuseDelete = true
  bot.uin = new Proxy([], {
    deleteProperty(target, key) {
      return refuseDelete && key === "0" ? false : Reflect.deleteProperty(target, key)
    },
  })
  const f = fixture(t, bot),
    installed = install(f.Bot)
  await bot.adapter[0].load()
  assert.throws(() => f.host.close(), AggregateError)
  assert.equal(bot[installed.id], undefined)
  assert.deepEqual([...bot.uin], [installed.id])
  refuseDelete = false
  assert.doesNotThrow(() => f.host.close())
  assert.deepEqual([...bot.uin], [])
})

test("guest logout retains local account lookup while registration, invoke and outbound events are revoked", async t => {
  const f = fixture(t),
    installed = install(f.Bot)
  await f.bot.adapter[0].load()
  const account = f.Bot[installed.id]
  const methodHandle = f.frames.findLast(frame => frame.type === "account").account.entityMethods
    .sendMsg
  let finishLogout
  account.logout = async () => {
    assert.equal(f.guest.getAccount(installed.id), account)
    await new Promise(resolve => {
      finishLogout = resolve
    })
    assert.equal(f.guest.getAccount(installed.id), account)
  }
  f.host.close()
  const before = f.frames.length
  const disposal = f.guest.dispose()
  await assert.rejects(
    f.guest.invoke({
      methodHandle,
      args: ["late"],
      selector: { kind: "friend", userId: "user-1" },
    }),
    { code: "ADAPTER_CLOSED" },
  )
  assert.throws(() => f.guest.register(installed.adapter), { code: "ADAPTER_CLOSED" })
  assert.throws(() => f.Bot.em("message.private", { self_id: installed.id }), {
    code: "ADAPTER_CLOSED",
  })
  f.Bot.em(`disconnect.${installed.id}`, { self_id: installed.id })
  assert.equal(f.frames.length, before)
  finishLogout()
  assert.equal((await disposal).logoutFailures, 0)
  assert.throws(() => f.guest.getAccount(installed.id), { code: "ADAPTER_CLOSED" })
})

test("frames reject live SDK objects, accessors, functions and oversized snapshots", () => {
  let accessed = false
  assert.throws(
    () =>
      adapterDto({
        get value() {
          accessed = true
          return "bad"
        },
      }),
    { code: "ADAPTER_INVALID_DTO" },
  )
  assert.equal(accessed, false)
  assert.throws(() => adapterDto({ fn() {} }), { code: "ADAPTER_INVALID_DTO" })
  assert.throws(() => adapterDto(new Date()), { code: "ADAPTER_INVALID_DTO" })
  assert.throws(() => adapterDto("x".repeat(65537)), { code: "ADAPTER_FRAME_LIMIT" })
  assert.throws(() =>
    validateAdapterFrame({
      type: "event",
      accountHandle: "account-00000000-0000-0000-0000-000000000000",
      name: "message",
      event: {},
      owner: "other-session",
    }),
  )
})
