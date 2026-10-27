import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { createHash } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"
import ts from "typescript"

const moduleRoot = process.env.GUARD_TEST_MODULE_ROOT
  ? pathToFileURL(`${path.resolve(process.env.GUARD_TEST_MODULE_ROOT)}${path.sep}`)
  : new URL("../dist/", import.meta.url)
const { restoreNativeEventFlags } = await import(
  new URL("native-sandbox/event-flags-guest.js", moduleRoot)
)
const { snapshotEvent, snapshotBotEventArguments } = await import(
  new URL("native-sandbox/event-snapshot.js", moduleRoot)
)
const coreFile = path.join(
  process.env.GUARD_TEST_CORE_SOURCE ?? fileURLToPath(new URL("./source/", import.meta.url)),
  "lib/plugins/loader.js",
)
// 需要 npm run test:prepare 准备的核心副本；缺少时跳过而不是在加载阶段崩溃。
if (!fs.existsSync(coreFile))
  test("actual core flag descriptors (requires prepared core source)", {
    skip: "missing tests/source; run npm run test:prepare",
  })
else {
  const coreSource = fs.readFileSync(coreFile, "utf8")
  const hash = value => createHash("sha256").update(value).digest("hex")
  const coreHash = hash(coreSource)
  const tree = ts.createSourceFile(
    "loader.js",
    coreSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  )
  const definitions = []
  const visit = node => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === "Object.defineProperty" &&
      node.arguments[0]?.getText(tree) === "e" &&
      ts.isStringLiteral(node.arguments[1]) &&
      ["isSr", "isGs"].includes(node.arguments[1].text)
    )
      definitions.push(node.getText(tree))
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.equal(
    definitions.length,
    2,
    "Use the actual core's two flag definitions, not a reimplementation",
  )
  const actualCoreFlags = new vm.Script(definitions.join("\n"), {
    filename: "actual-core-game-flags.js",
  })
  const withCoreFlags = event => {
    actualCoreFlags.runInNewContext({ e: event })
    return event
  }
  const guestCopy = value => JSON.parse(JSON.stringify(value))

  test("actual core flag descriptors survive snapshot and Guest restoration with original game semantics", () => {
    for (const game of ["sr", "gs", "zzz", "unknown", undefined]) {
      const host = withCoreFlags({ post_type: "message", game })
      for (const flag of ["isSr", "isGs"]) {
        const descriptor = Object.getOwnPropertyDescriptor(host, flag)
        assert.equal(descriptor.enumerable, false)
        assert.equal(descriptor.configurable, false)
        assert.equal(typeof descriptor.get, "function")
        assert.equal(typeof descriptor.set, "function")
      }
      const snapshot = snapshotEvent(host),
        guest = guestCopy(snapshot)
      assert.equal(snapshot.isSr, host.isSr)
      assert.equal(snapshot.isGs, host.isGs)
      assert.equal(restoreNativeEventFlags(guest), guest)
      for (const flag of ["isSr", "isGs"]) {
        const descriptor = Object.getOwnPropertyDescriptor(guest, flag)
        assert.equal(descriptor.enumerable, false)
        assert.equal(descriptor.configurable, false)
        assert.equal(typeof descriptor.get, "function")
        assert.equal(typeof descriptor.set, "function")
      }
      assert.equal(guest.isSr, game === "sr")
      assert.equal(guest.isGs, game === "gs")
      guest.isSr = true
      assert.equal(guest.game, "sr")
      assert.equal(guest.isGs, false)
      guest.isSr = false
      assert.equal(guest.game, "gs")
      assert.equal(guest.isGs, true)
      guest.isGs = false
      assert.equal(guest.game, "sr")
      guest.isGs = true
      assert.equal(guest.game, "gs")
      guest.game = "zzz"
      assert.equal(guest.isSr, false)
      assert.equal(guest.isGs, false)
      assert.equal(host.game, game, "Guest writes must not mutate the original host event")
      assert.equal(Object.keys(guest).includes("isSr"), false)
      const getter = Object.getOwnPropertyDescriptor(guest, "isSr").get
      assert.equal(restoreNativeEventFlags(guest), guest)
      assert.equal(Object.getOwnPropertyDescriptor(guest, "isSr").get, getter)
      assert.equal(Reflect.deleteProperty(guest, "isSr"), false)
    }
    assert.equal(hash(fs.readFileSync(coreFile, "utf8")), coreHash)
  })

  test("missing own game derives false flags without looking at an inherited game getter", () => {
    let calls = 0
    const prototype = {
      get game() {
        calls++
        return "sr"
      },
    }
    const host = withCoreFlags(Object.assign(Object.create(prototype), { post_type: "message" }))
    const snapshot = snapshotEvent(host)
    assert.equal(calls, 0)
    assert.equal(snapshot.game, undefined)
    assert.equal(snapshot.isSr, false)
    assert.equal(snapshot.isGs, false)
    const guest = restoreNativeEventFlags(guestCopy(snapshot))
    guest.isGs = true
    assert.equal(guest.game, "gs")
    assert.equal(Object.hasOwn(host, "game"), false)
  })

  test("flag projection never executes host accessors, including game, post_type and unknown getters", () => {
    let calls = 0
    const sideEffect = () => {
      calls++
      throw new Error("Host getter must not run")
    }
    const host = { post_type: "message", game: "sr" }
    for (const flag of ["isSr", "isGs"])
      Object.defineProperty(host, flag, { get: sideEffect, set: sideEffect })
    Object.defineProperty(host, "unknown", { get: sideEffect, enumerable: true })
    assert.deepEqual(guestCopy(snapshotEvent(host)), {
      post_type: "message",
      game: "sr",
      isSr: true,
      isGs: false,
    })
    const gameAccessor = withCoreFlags({ post_type: "message" })
    Object.defineProperty(gameAccessor, "game", { get: sideEffect, enumerable: true })
    const snapshot = snapshotEvent(gameAccessor)
    assert.equal(snapshot.game, undefined)
    assert.equal(snapshot.isSr, undefined)
    assert.equal(snapshot.isGs, undefined)
    const typeAccessor = withCoreFlags({ game: "sr" })
    Object.defineProperty(typeAccessor, "post_type", { get: sideEffect, enumerable: true })
    assert.equal(snapshotEvent(typeAccessor).isSr, undefined)
    assert.equal(calls, 0)
  })

  test("only root message core-shaped flag accessors gain a derived boolean", () => {
    for (const post_type of ["notice", "request", undefined]) {
      const value = snapshotEvent(withCoreFlags({ post_type, game: "sr" }))
      assert.equal(value.isSr, undefined)
      assert.equal(value.isGs, undefined)
    }
    const nested = snapshotEvent({ payload: withCoreFlags({ post_type: "message", game: "sr" }) })
    assert.equal(nested.payload.isSr, undefined)
    assert.equal(nested.payload.isGs, undefined)
    for (const descriptor of [
      { get: () => true },
      { get: () => true, set() {}, enumerable: true },
      { get: () => true, set() {}, configurable: true },
    ]) {
      const host = { post_type: "message", game: "sr" }
      Object.defineProperty(host, "isSr", descriptor)
      assert.equal(snapshotEvent(host).isSr, undefined)
    }
    assert.equal(Object.hasOwn(snapshotEvent({ post_type: "message", game: "sr" }), "isSr"), false)
  })

  test("Guest restoration requires a boolean DTO marker and leaves isMaster descriptors unchanged", () => {
    const guest = { game: "sr", isSr: true, isGs: false }
    Object.defineProperty(guest, "isMaster", { value: false })
    const master = Object.getOwnPropertyDescriptor(guest, "isMaster")
    restoreNativeEventFlags(guest)
    assert.deepEqual(Object.getOwnPropertyDescriptor(guest, "isMaster"), master)
    assert.throws(() => {
      guest.isMaster = true
    }, TypeError)
    const ordinary = { game: "sr", isSr: "true", isGs: 0 }
    restoreNativeEventFlags(ordinary)
    assert.equal(ordinary.isSr, "true")
    assert.equal(ordinary.isGs, 0)
    const absent = { game: "sr" }
    restoreNativeEventFlags(absent)
    assert.equal(Object.hasOwn(absent, "isSr"), false)
    const locked = { game: "gs" }
    Object.defineProperty(locked, "isSr", { value: false })
    const before = Object.getOwnPropertyDescriptor(locked, "isSr")
    restoreNativeEventFlags(locked)
    assert.deepEqual(Object.getOwnPropertyDescriptor(locked, "isSr"), before)
  })

  test("Guest accessors close over the restored event and retain core truthy/falsy setter behavior", () => {
    const guest = restoreNativeEventFlags({ game: "gs", isSr: false, isGs: true })
    const descriptor = Object.getOwnPropertyDescriptor(guest, "isSr")
    descriptor.set.call({ game: "other" }, "truthy")
    assert.equal(guest.game, "sr")
    assert.equal(descriptor.get.call({ game: "other" }), true)
    descriptor.set.call({}, 0)
    assert.equal(guest.game, "gs")
  })

  test("SDK allowlist, first-argument restriction and online/protected identity projection stay intact", () => {
    class Message {
      post_type = "message"
      game = "sr"
      raw_message = "fixture text"
      user_id = 123
      message = [{ type: "text", text: "fixture text" }]
      token = "secret-sdk-token"
      proto = { private: "protobuf" }
      bot = { private: "host" }
    }
    const message = withCoreFlags(new Message())
    Object.defineProperty(message, "isMaster", { value: false })
    const snapshot = snapshotBotEventArguments([message], "message")[0]
    assert.equal(snapshot.isSr, true)
    assert.equal(snapshot.isGs, false)
    assert.equal(snapshot.isMaster, false)
    for (const key of ["token", "proto", "bot"]) assert.equal(snapshot[key], undefined)
    assert.equal(snapshotBotEventArguments([{}, message])[1], null)
    class Account {
      game = "sr"
      token = "private-account"
    }
    const account = withCoreFlags(new Account())
    assert.deepEqual(snapshotBotEventArguments([account]), [null])
    const bots = { account },
      Bot = new Proxy(bots, { get: (target, key) => target[key] })
    const options = {
      protectedObjects: new Set([Bot, bots, account]),
      botState: { uin: ["public-account"] },
    }
    assert.deepEqual(snapshotBotEventArguments([Bot], "online", options), [
      { uin: ["public-account"] },
    ])
    assert.deepEqual(snapshotBotEventArguments([account], "connect.public-account", options), [
      { uin: ["public-account"] },
    ])
    assert.deepEqual(snapshotBotEventArguments([Bot], "custom", options), [null])
    assert.deepEqual(
      guestCopy(
        snapshotBotEventArguments([{ nested: { Bot, account }, safe: true }], "custom", options),
      ),
      [{ nested: {}, safe: true }],
    )
  })
}
