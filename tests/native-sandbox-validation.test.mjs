import test from "node:test"
import assert from "node:assert/strict"
import {
  validateNativeDescriptor,
  validateReplyArguments,
} from "../dist/native-sandbox/validation.js"
import { encodeNativePriority, parseNativePriority } from "../dist/native-sandbox/priority.js"

const descriptor = () => ({
  id: "index.js#Sample",
  name: "Sample",
  methods: ["handle"],
  metadata: {
    name: "sample",
    dsc: "sample",
    event: "message",
    priority: 1000,
    rule: [{ reg: { $type: "RegExp", source: "(a+)+$", flags: "" }, fnc: "handle" }],
    task: { name: "", cron: "", fnc: "" },
  },
})

test("native metadata accepts DTO rules without executing guest regex or callbacks", () => {
  const value = descriptor()
  assert.equal(validateNativeDescriptor(value), value)
  value.metadata.task = {
    name: "task",
    cron: "*/1 * * * * *",
    fnc: { $type: "NativeFunction", id: "cb-fixture" },
  }
  value.metadata.handler = [{ key: "example", fn: "handle", priority: 500 }]
  assert.equal(validateNativeDescriptor(value), value)
})

test("native metadata refuses host methods, scheduler objects and non-data fields", () => {
  for (const mutate of [
    item => (item.metadata.handler = [{ key: "example", fn: "renderImg" }]),
    item => (item.metadata.task.job = { $type: "NativeFunction", id: "cb-fixture" }),
    item => (item.metadata.task.cron = { $type: "NativeFunction", id: "cb-fixture" }),
    item => (item.metadata.rule[0].event = { $type: "NativeFunction", id: "cb-fixture" }),
    item => (item.metadata.handler = [{ key: "example", fn: "reply" }]),
    item => item.methods.push("__proto__"),
  ]) {
    const item = descriptor()
    mutate(item)
    assert.throws(() => validateNativeDescriptor(item))
  }
})

test("reply broker accepts only bounded text and empty options", () => {
  assert.deepEqual(validateReplyArguments(["hello"]), ["hello", false, {}])
  assert.deepEqual(
    validateReplyArguments([[{ type: "text", text: "hello" }, " world"], true, {}]),
    [[{ type: "text", text: "hello" }, " world"], true, {}],
  )
  for (const args of [
    [{ type: "image", file: "file:///private/secret" }],
    [
      [
        { type: "text", text: "ok" },
        { type: "file", file: "https://example.test/private" },
      ],
    ],
    [{ type: "text", text: "ok", file: "/secret" }],
    ["ok", false, { recallMsg: 1 }],
    ["ok", { file: "/secret" }],
    ["x".repeat(32001)],
  ])
    assert.throws(() => validateReplyArguments(args))
})

test("original infinite ordering priorities use exact tags while general invalid metadata remains denied", () => {
  for (const value of [-Infinity, -1, 0, 1, Infinity]) {
    const tag = encodeNativePriority(value)
    assert.equal(parseNativePriority(JSON.parse(JSON.stringify(tag))), value)
    const item = descriptor()
    item.metadata.priority = tag
    item.metadata.handler = [{ key: "sample", fn: "handle", priority: tag }]
    assert.equal(validateNativeDescriptor(item), item)
  }
  for (const value of [
    NaN,
    null,
    "Infinity",
    { $type: "NativePriority", value: "NaN" },
    { $type: "NativePriority", value: "negative-infinity", extra: true },
  ])
    assert.throws(() => parseNativePriority(value))
  let getter = false
  assert.throws(() =>
    parseNativePriority({
      $type: "NativePriority",
      get value() {
        getter = true
        return "negative-infinity"
      },
    }),
  )
  assert.equal(getter, false)
  assert.throws(() => encodeNativePriority(NaN))
})
