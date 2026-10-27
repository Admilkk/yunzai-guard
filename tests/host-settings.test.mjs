import assert from "node:assert/strict"
import test from "node:test"
import { parseSettings } from "../dist/config/index.js"
import { SettingsController } from "../dist/host/settings.js"

function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const withRule = (settings, id) => parseSettings({ ...settings, rules: [{ id, action: "deny" }] })

test("mixed changes prepare first, commit policies after reload and retain the host restart notice", async () => {
  const initial = parseSettings({ controlPort: 21733 })
  const next = parseSettings({
    ...withRule(initial, "custom"),
    controlPort: 21734,
    recovery: { ...initial.recovery, maxRestarts: 5 },
  })
  const calls = []
  const controller = new SettingsController(initial, {
    async prepare(candidate) {
      calls.push("prepare")
      assert.equal(candidate.controlPort, 21733)
      assert.deepEqual(controller.active, initial)
      return "prepared"
    },
    applyLive(live) {
      calls.push("live")
      assert.deepEqual(live.rules, [])
      assert.equal(live.recovery.maxRestarts, 5)
    },
    async reload(candidate, prepared) {
      calls.push("reload")
      assert.equal(prepared, "prepared")
      assert.equal(controller.active.recovery.maxRestarts, 5)
      assert.deepEqual(controller.active.rules, [])
      assert.equal(candidate.rules[0].id, "custom")
    },
  })
  assert.equal(controller.request(next).status, "applying")
  const state = await controller.applyPending()
  assert.deepEqual(calls, ["prepare", "live", "reload"])
  assert.equal(controller.active.rules[0].id, "custom")
  assert.equal(controller.active.controlPort, 21733)
  assert.equal(controller.hasPending, false)
  assert.equal(state.status, "pending-restart")
  assert.equal(state.mode, "host-restart")
  assert.deepEqual(state.restartFields, ["controlPort"])
  assert.throws(() => state.restartFields.push("rules"), TypeError)
})

test("a save during preflight supersedes the old reload without losing the latest request", async () => {
  const initial = parseSettings({})
  const waiting = deferred()
  const reloads = []
  let prepares = 0
  const controller = new SettingsController(initial, {
    async prepare() {
      if (++prepares === 1) await waiting.promise
    },
    applyLive() {},
    async reload(candidate) {
      reloads.push(candidate.rules[0].id)
    },
  })
  controller.request(withRule(initial, "first"))
  const applying = controller.applyPending()
  assert.equal(controller.request(withRule(initial, "latest")).revision, 2)
  waiting.resolve()
  const state = await applying
  assert.equal(state.revision, 2)
  assert.equal(state.status, "applying")
  assert.equal(controller.hasPending, true)
  assert.deepEqual(controller.active, initial)
  assert.deepEqual(reloads, [])
  await controller.applyPending()
  assert.deepEqual(reloads, ["latest"])
  assert.equal(controller.active.rules[0].id, "latest")
  assert.equal(controller.state.status, "applied")
})

test("a revert saved during an active reload survives even when it matches the previous settings", async () => {
  const initial = parseSettings({})
  const waiting = deferred()
  let reloads = 0
  const controller = new SettingsController(initial, {
    async prepare() {},
    applyLive() {},
    async reload() {
      if (++reloads === 1) await waiting.promise
    },
  })
  controller.request(withRule(initial, "first"))
  const applying = controller.applyPending()
  await Promise.resolve()
  controller.request(initial)
  waiting.resolve()
  await applying
  assert.equal(controller.hasPending, true)
  assert.equal(controller.state.revision, 2)
  assert.equal(controller.state.status, "applying")
  assert.equal(controller.active.rules[0].id, "first")
  await controller.applyPending()
  assert.equal(reloads, 2)
  assert.deepEqual(controller.active, initial)
  assert.equal(controller.state.status, "applied")
})

test("failed updates terminate without committing candidate policies and the same document can retry", async () => {
  const initial = parseSettings({})
  const next = parseSettings({
    ...withRule(initial, "custom"),
    recovery: { ...initial.recovery, maxRestarts: 5 },
  })
  let fail = "prepare"
  const controller = new SettingsController(initial, {
    async prepare() {
      if (fail === "prepare") throw new Error("preflight failed")
    },
    applyLive() {},
    async reload() {
      if (fail === "reload") throw new Error("reload failed")
    },
  })
  controller.request(next)
  assert.equal((await controller.applyPending()).error, "preflight failed")
  assert.deepEqual(controller.active, initial)
  assert.equal(controller.hasPending, false)
  fail = "reload"
  controller.request(next)
  assert.equal((await controller.applyPending()).error, "reload failed")
  assert.equal(controller.active.recovery.maxRestarts, 5)
  assert.deepEqual(controller.active.rules, [])
  assert.equal(controller.hasPending, false)
  fail = ""
  controller.request(next)
  assert.equal((await controller.applyPending()).status, "applied")
  assert.deepEqual(controller.active, next)
})

test("an old failure does not overwrite a newer save and host-only changes do not loop", async () => {
  const initial = parseSettings({})
  const waiting = deferred()
  let prepares = 0
  const controller = new SettingsController(initial, {
    async prepare() {
      if (++prepares === 1) await waiting.promise
    },
    applyLive() {
      assert.fail("host-only changes must not apply live operations")
    },
    async reload() {
      assert.fail("failed preflight must not reload")
    },
  })
  controller.request(withRule(initial, "first"))
  const applying = controller.applyPending()
  controller.request(parseSettings({ controlPort: 21733 }))
  waiting.reject(new Error("obsolete preflight failed"))
  assert.equal((await applying).revision, 2)
  const state = await controller.applyPending()
  assert.equal(state.status, "pending-restart")
  assert.equal(state.error, undefined)
  assert.equal(controller.hasPending, false)
  assert.deepEqual(controller.active, initial)
  assert.equal((await controller.applyPending()).revision, 2)
  assert.throws(() => controller.request({ unknown: true }), /未知配置项：settings\.unknown/)
  assert.equal(controller.state.revision, 2)
})
