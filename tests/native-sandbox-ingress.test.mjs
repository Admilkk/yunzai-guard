import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { NativePluginClient } from "../dist/native-sandbox/client.js"
import * as transport from "../dist/native-sandbox/transport.js"
import { parseSettings } from "../dist/config/index.js"

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
function fixture(t) {
  const runs = path.join(repository, "tests/runs")
  fs.mkdirSync(runs, { recursive: true })
  const root = fs.mkdtempSync(path.join(runs, "native-ingress-"))
  fs.mkdirSync(path.join(root, "plugins/flood-fixture"), { recursive: true })
  const settings = parseSettings({
    pluginSandbox: { native: { plugins: [{ id: "flood-fixture", hookAction: "audit" }] } },
  })
  let writes = 0,
    closes = 0
  const events = []
  const original = Object.getOwnPropertyDescriptor(globalThis, "logger")
  Object.defineProperty(globalThis, "logger", {
    configurable: true,
    value: {
      error() {
        writes++
      },
    },
  })
  const client = new NativePluginClient(
    root,
    settings.pluginSandbox.native.plugins[0],
    settings,
    event => events.push(event),
    () => ({}),
  )
  client.readyPromise = Promise.resolve()
  client.session = {
    platform: process.platform,
    child: {
      connected: true,
      send(_frame, callback) {
        callback?.(null)
        return true
      },
    },
    async close() {
      closes++
    },
  }
  const deliver = frame => {
    try {
      client.receive(frame)
    } catch (error) {
      client.stop(error)
    }
  }
  t.after(async () => {
    try {
      await client.close()
    } finally {
      if (original) Object.defineProperty(globalThis, "logger", original)
      else delete globalThis.logger
      const resolved = fs.realpathSync.native(root)
      if (
        path.dirname(resolved) !== fs.realpathSync.native(runs) ||
        !path.basename(resolved).startsWith("native-ingress-")
      )
        throw new Error("Unsafe ingress fixture cleanup")
      fs.rmSync(resolved, { recursive: true, force: true })
    }
  })
  return { client, deliver, events, writes: () => writes, closes: () => closes }
}

test("native error-log flood has bounded host writes and revokes the session before later frames", async t => {
  const f = fixture(t),
    frame = { type: "native-log", level: "error", args: ["benign-flood-fixture"] }
  for (let index = 0; index < 10000; index++) f.deliver(frame)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(f.writes() < 128, `Host logger received ${f.writes()} writes from a bounded test burst`)
  assert.equal(f.closes(), 1, "Overflow must close the OS scope")
  const stopped = f.writes()
  for (let index = 0; index < 1000; index++) f.deliver(frame)
  assert.equal(f.writes(), stopped, "No writes may continue while or after scope termination")
})

test("several hundred startup info logs fit the native session budget", async t => {
  const f = fixture(t)
  for (let index = 0; index < 500; index++)
    f.deliver({ type: "native-log", level: "info", args: ["startup fixture", index] })
  assert.equal(f.events.filter(event => event.operation === "native.log").length, 500)
  assert.equal(f.writes(), 0)
  assert.equal(f.closes(), 0)
})

test("unknown native control frames revoke the session before further guest events", async t => {
  const f = fixture(t)
  f.deliver({ type: "restart-request", plugin: "system", action: "audit" })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.closes(), 1)
  const count = f.events.length
  f.deliver({ type: "native-log", level: "info", args: ["must not run"] })
  assert.equal(f.events.length, count)
})

test("audit hook floods remain bounded and cannot keep the host audit path active after stopping", async t => {
  const f = fixture(t)
  for (let index = 0; index < 10000; index++)
    f.deliver({ type: "native-hook", target: "Bot.benignFixture" })
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(f.events.filter(event => event.operation === "native.hook").length < 512)
  assert.equal(f.closes(), 1)
  const stopped = f.events.length
  f.deliver({ type: "native-hook", target: "Bot.lateFixture" })
  assert.equal(f.events.length, stopped)
})

test("ingress quotas refill with monotonic time, tolerate startup bursts and never reset a sealed session", () => {
  let time = 0
  const budget = new transport.NativeIngressBudget(() => time)
  budget.consume("frame", 4096)
  budget.consume("bytes", 8 * 1024 * 1024)
  budget.consume("log", 1000)
  budget.consume("diagnostic", 64)
  budget.consume("hook", 256)
  budget.consume("task", 64)
  time = 1000
  budget.consume("frame", 512)
  budget.consume("bytes", 1024 * 1024)
  budget.consume("log", 32)
  budget.consume("diagnostic", 2)
  budget.consume("hook", 16)
  budget.consume("task", 8)
  assert.equal(budget.sealed, false)
  assert.throws(
    () => budget.consume("diagnostic"),
    error => error.code === "NATIVE_INGRESS_LIMIT",
  )
  assert.equal(budget.sealed, true)
  time = 24 * 60 * 60 * 1000
  assert.throws(
    () => budget.consume("frame"),
    error => error.code === "NATIVE_INGRESS_LIMIT",
  )
})

test("healthy long-running sessions have rate limits without an eventual lifetime cutoff", () => {
  let time = 0
  const budget = new transport.NativeIngressBudget(() => time)
  for (let index = 0; index < 10000; index++) {
    time += 1000
    budget.consume("frame", 500)
    budget.consume("bytes", 1000000)
    budget.consume("log", 30)
    budget.consume("diagnostic", 2)
    budget.consume("hook", 15)
    budget.consume("task", 8)
  }
  assert.equal(budget.sealed, false)
})

test("successful high-frequency tasks consume host quota even without errors or guest logs", () => {
  let time = 0
  const budget = new transport.NativeIngressBudget(() => time)
  budget.consume("task", 64)
  time = 1000
  budget.consume("task", 8)
  assert.throws(
    () => budget.consume("task"),
    error => error.code === "NATIVE_INGRESS_LIMIT",
  )
  assert.equal(budget.sealed, true)
})
