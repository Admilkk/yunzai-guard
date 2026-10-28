import assert from "node:assert/strict"
import test from "node:test"
import { EventCoalescer } from "../dist/runtime/coalesce.js"
import { parseSettings } from "../dist/config/index.js"

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const event = (target, action = "audit") => ({
  plugin: "demo",
  kind: "filesystem",
  operation: "fs.readFile",
  target,
  action,
})

test("identical events inside the window collapse into one plus a repeat summary", async () => {
  const sent = []
  const coalescer = new EventCoalescer({
    windowMs: () => 30,
    maxKeys: 100,
    forward: item => (sent.push(item), true),
  })
  for (let index = 0; index < 1000; index++) coalescer.offer(event("/a"), false)
  coalescer.offer(event("/b"), false)
  assert.equal(sent.length, 2)
  await wait(80)
  const summary = sent.find(item => item.details?.repeated)
  assert.equal(summary.details.repeated, 999)
  assert.equal(summary.target, "/a")
  coalescer.close()
})

test("deny, restart and critical events are never merged", () => {
  const sent = []
  const coalescer = new EventCoalescer({
    windowMs: () => 1000,
    maxKeys: 100,
    forward: item => (sent.push(item), true),
  })
  for (let index = 0; index < 5; index++) coalescer.offer(event("/x", "deny"), true)
  for (let index = 0; index < 5; index++) coalescer.offer(event("/x", "restart"), false)
  assert.equal(sent.length, 10)
  coalescer.close()
})

test("a zero window disables merging and the key cap bounds memory", () => {
  const sent = []
  const off = new EventCoalescer({
    windowMs: () => 0,
    maxKeys: 100,
    forward: item => (sent.push(item), true),
  })
  for (let index = 0; index < 3; index++) off.offer(event("/a"), false)
  assert.equal(sent.length, 3)
  const capped = []
  const small = new EventCoalescer({
    windowMs: () => 1000,
    maxKeys: 2,
    forward: item => (capped.push(item), true),
  })
  for (const target of ["/1", "/2", "/3", "/3"]) small.offer(event(target), false)
  assert.equal(capped.length, 4)
  small.close()
})

test("rejected events are reported later as an overflow record", () => {
  let accept = false
  const sent = []
  const coalescer = new EventCoalescer({
    windowMs: () => 1000,
    maxKeys: 100,
    forward: item => (accept ? (sent.push(item), true) : false),
  })
  for (let index = 0; index < 7; index++) coalescer.offer(event(`/f${index}`), false)
  accept = true
  coalescer.close()
  const overflow = sent.find(item => item.operation === "audit-overflow")
  assert.equal(overflow.details.dropped, 7)
  assert.equal(overflow.plugin, "demo")
})

test("high-volume defaults and durability options parse", () => {
  const settings = parseSettings({})
  assert.equal(settings.audit.maxEventsPerSecond, 1000)
  assert.equal(settings.audit.maxQueue, 5000)
  assert.equal(settings.audit.coalesceMs, 1000)
  assert.equal(settings.audit.durability, "adaptive")
  assert.throws(() => parseSettings({ audit: { durability: "never" } }))
})
