import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { waitForBootstrapReady } from "../dist/host/bootstrap/ready.js"

function core(online = 1) {
  return Object.assign(new EventEmitter(), { stat: { online } })
}

test("bootstrap readiness accepts an already online core and releases its listener", async () => {
  const bot = core(2)
  await waitForBootstrapReady(bot, 1000)
  assert.equal(bot.listenerCount("online"), 0)
})

test("bootstrap does not close resources during parallel loader initialization", async () => {
  const bot = core()
  let ready = false
  const pending = waitForBootstrapReady(bot, 1000).then(() => {
    ready = true
  })
  bot.emit("online")
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ready, false)
  assert.equal(bot.listenerCount("online"), 1)
  bot.stat.online = 2
  bot.emit("online")
  await pending
  assert.equal(ready, true)
  assert.equal(bot.listenerCount("online"), 0)
})

test("bootstrap readiness timeout fails closed and releases its listener", async () => {
  const bot = core()
  await assert.rejects(waitForBootstrapReady(bot, 20), /核心启动超时/)
  assert.equal(bot.listenerCount("online"), 0)
})

test("shutdown cancels readiness so later online cannot start a handoff", async () => {
  const bot = core()
  const controller = new AbortController()
  const pending = waitForBootstrapReady(bot, 1000, controller.signal)
  controller.abort()
  await assert.rejects(pending, /就绪等待已取消/)
  assert.equal(bot.listenerCount("online"), 0)
  bot.stat.online = 2
  bot.emit("online")
  await assert.rejects(waitForBootstrapReady(bot, 1000, controller.signal), /就绪等待已取消/)
  assert.equal(bot.listenerCount("online"), 0)
})
