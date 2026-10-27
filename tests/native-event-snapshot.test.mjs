import assert from "node:assert/strict"
import test from "node:test"
import { snapshotEvent } from "../dist/native-sandbox/client.js"
import { snapshotBotEventArguments } from "../dist/native-sandbox/event-snapshot.js"

test("event snapshots preserve core non-enumerable master values without invoking accessors", () => {
  for (const isMaster of [true, false]) {
    const event = { user_id: "fixture", msg: "message" }
    Object.defineProperty(event, "isMaster", { value: isMaster })
    Object.defineProperty(event, "secret", { value: "host-only" })
    let called = false
    Object.defineProperty(event, "getter", {
      enumerable: true,
      get() {
        called = true
        return "hidden"
      },
    })
    const snapshot = snapshotEvent(event)
    assert.equal(snapshot.isMaster, isMaster)
    assert.equal(snapshot.secret, undefined)
    assert.equal(snapshot.getter, undefined)
    assert.equal(called, false)
    assert.equal(snapshotEvent({ args: [event] }).args[0].isMaster, isMaster)
    snapshot.isMaster = !isMaster
    assert.equal(event.isMaster, isMaster, "a guest value must not change the host authority")
  }
  let called = false
  const event = {}
  Object.defineProperty(event, "isMaster", {
    get() {
      called = true
      return true
    },
  })
  assert.equal(snapshotEvent(event).isMaster, undefined)
  assert.equal(called, false)
})

test("SDK message roots project only public values while account and protobuf objects remain local", () => {
  class Message {
    post_type = "message"
    message_type = "group"
    user_id = 456
    group_id = 789
    message = [{ type: "text", text: "fixture text" }]
    raw_message = "fixture text"
    sender = { nickname: "fixture" }
    proto = { secret: "protobuf internals" }
    parsed = { secret: "parser internals" }
    token = "account secret"
    bot = { token: "host secret" }
    reply() {
      throw new Error("host function must stay local")
    }
  }
  const event = new Message()
  Object.defineProperty(event, "isMaster", { value: true })
  const snapshot = snapshotEvent(event)
  assert.equal(snapshot.user_id, 456)
  assert.equal(snapshot.group_id, 789)
  assert.equal(snapshot.isMaster, true)
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.message)), [
    { type: "text", text: "fixture text" },
  ])
  for (const key of ["proto", "parsed", "token", "bot", "reply"])
    assert.equal(snapshot[key], undefined)
  assert.deepEqual(snapshotBotEventArguments([event])[0], snapshot)
  class Account {
    token = "host account"
  }
  assert.deepEqual(snapshotBotEventArguments([new Account()]), [null])
  assert.equal(snapshotBotEventArguments([{}, event])[1], null)
  const nested = snapshotEvent({ payload: event })
  assert.equal(nested.payload, undefined)
  let called = false
  const malicious = {}
  Object.defineProperty(malicious, "post_type", {
    get() {
      called = true
      return "message"
    },
  })
  snapshotBotEventArguments([malicious])
  const array = []
  Object.defineProperty(array, 0, {
    get() {
      called = true
      return "secret"
    },
  })
  assert.deepEqual(snapshotBotEventArguments([array]), [[null]])
  assert.equal(called, false)
})
