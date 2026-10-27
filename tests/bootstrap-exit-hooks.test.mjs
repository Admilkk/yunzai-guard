import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { resolveExitHook } from "../dist/host/bootstrap/exit-hooks.js"

test("exitEvent remains authoritative and preserves its receiver and budget", async () => {
  const calls = []
  const bot = {
    async exitEvent(reason, budget) {
      assert.equal(this, bot)
      calls.push([reason, budget])
    },
    rawListeners() {
      assert.fail("exitEvent must take precedence")
    },
    exit() {
      assert.fail("Bot.exit must never be invoked")
    },
  }
  await resolveExitHook(bot)("restart", 200)
  assert.deepEqual(calls, [["restart", 200]])
})

test("raw exit hooks preserve once wrappers, receiver and single preparation", async () => {
  const bot = new EventEmitter()
  const calls = []
  bot.exit = () => assert.fail("Bot.exit must never be invoked")
  bot.once("exit", async function (reason) {
    assert.equal(this, bot)
    await Promise.resolve()
    calls.push(["once", reason])
  })
  bot.on("exit", function (reason) {
    assert.equal(this, bot)
    calls.push(["on", reason])
  })
  const run = resolveExitHook(bot)
  const result = run("restart", 200)
  assert.equal(run("exit", 500), result)
  await result
  assert.deepEqual(calls.sort(), [
    ["on", "restart"],
    ["once", "restart"],
  ])
  assert.equal(bot.listenerCount("exit"), 1)
})

test("one raw exit failure cannot skip another listener or become unhandled", async () => {
  const bot = new EventEmitter()
  const failure = Error("persistence-failed")
  const calls = []
  bot.once("exit", () => {
    calls.push("failed")
    throw failure
  })
  bot.once("exit", async () => calls.push("completed"))
  await assert.rejects(resolveExitHook(bot)("restart", 200), error => {
    assert.deepEqual(error.errors, [failure])
    return true
  })
  assert.deepEqual(calls, ["failed", "completed"])
  assert.equal(bot.listenerCount("exit"), 0)
})

test("raw hooks share one deadline and cannot run twice after timeout", async () => {
  const bot = new EventEmitter()
  let calls = 0
  bot.once("exit", () => new Promise(() => {}))
  bot.once("exit", () => calls++)
  const run = resolveExitHook(bot)
  const result = run("restart", 30)
  await assert.rejects(result, /退出钩子超时/)
  assert.equal(run("restart", 100), result)
  assert.equal(calls, 1)
  assert.equal(bot.listenerCount("exit"), 0)
})
