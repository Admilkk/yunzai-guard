import assert from "node:assert/strict"
import test from "node:test"
import { snapshotNativeBot, parseNativeBotSnapshot } from "../dist/native-sandbox/bot-snapshot.js"

test("decorated TRSS account lists copy only scalar IDs without invoking account or JSON helpers", () => {
  let called = false
  const uin = Object.assign(["stdin", 123, "protocol-user"], {
    toJSON() {
      called = true
      throw Error("must not execute")
    },
    now: 123,
  })
  const snapshot = snapshotNativeBot({ uin, 123: { sdk: { secret: "not-exported" } } })
  assert.deepEqual(snapshot, { uin: ["stdin", 123, "protocol-user"] })
  snapshot.uin.push("local-only")
  assert.equal(uin.length, 3)
  assert.equal(called, false)
  assert.deepEqual(snapshotNativeBot(undefined), { uin: [] })
})

test("wire account lists reject holes, accessors, SDK objects and excessive IDs", () => {
  let called = false
  const getter = ["stdin"]
  Object.defineProperty(getter, "0", {
    enumerable: true,
    get() {
      called = true
      return "not-evaluated"
    },
  })
  for (const uin of [
    getter,
    Array(1),
    Array(257).fill(1),
    [{}],
    ["__proto__"],
    Object.assign([], { extra: true }),
  ])
    assert.throws(() => parseNativeBotSnapshot({ uin }))
  assert.equal(called, false)
})
