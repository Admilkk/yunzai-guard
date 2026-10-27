import test from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { once } from "node:events"
import { RuntimeBroker } from "../dist/runtime/broker.js"
import { parseSettings } from "../dist/config/index.js"

test("runtime manifest failure removes only its newly allocated directory and preserves cleanup failures", () => {
  const originalMkdtemp = fs.mkdtempSync,
    originalRm = fs.rmSync
  let directory,
    cleanupFault = false
  const circular = { ...parseSettings({}) }
  circular.fixture = circular
  fs.mkdtempSync = (...args) => {
    directory = originalMkdtemp(...args)
    return directory
  }
  fs.rmSync = (target, options) => {
    if (cleanupFault && target === directory) throw new Error("owned cleanup fixture failure")
    return originalRm(target, options)
  }
  try {
    assert.throws(() => new RuntimeBroker(circular, 1, "bad-manifest", () => {}), /circular/i)
    assert.equal(fs.existsSync(directory), false)
    cleanupFault = true
    assert.throws(
      () => new RuntimeBroker(circular, 1, "bad-manifest", () => {}),
      error => {
        assert.ok(error instanceof AggregateError)
        assert.match(error.errors[0].message, /circular/i)
        assert.match(error.errors[1].message, /owned cleanup fixture failure/)
        return true
      },
    )
    assert.equal(fs.existsSync(directory), true)
  } finally {
    fs.mkdtempSync = originalMkdtemp
    fs.rmSync = originalRm
    if (directory && fs.existsSync(directory)) {
      assert.equal(
        path.dirname(fs.realpathSync.native(directory)),
        fs.realpathSync.native(os.tmpdir()),
      )
      assert.ok(path.basename(directory).startsWith("yunzai-guard-runtime-"))
      originalRm(directory, { recursive: true })
    }
  }
})

test("failed broker listen cleans its directory while retaining an unrelated owner of the endpoint", async () => {
  const broker = new RuntimeBroker(parseSettings({}), 1, "listen-failure", () => {})
  const unrelated = net.createServer()
  await new Promise((resolve, reject) => {
    unrelated.once("error", reject)
    unrelated.listen(broker.manifest.endpoint, resolve)
  })
  try {
    await assert.rejects(broker.listen(), { code: "EADDRINUSE" })
    await broker.close()
    assert.equal(fs.existsSync(broker.directory), false)
    assert.equal(unrelated.listening, true)
  } finally {
    await new Promise(resolve => unrelated.close(resolve))
    await broker.close()
  }
})

test("broker listen failure does not swallow a different server cleanup error", async () => {
  const broker = new RuntimeBroker(parseSettings({}), 1, "listen-cleanup-failure", () => {})
  const createServer = net.createServer
  let owned
  net.createServer = () => {
    owned = createServer()
    owned.listen = () => {
      queueMicrotask(() =>
        owned.emit("error", Object.assign(new Error("owned listen fault"), { code: "EADDRINUSE" })),
      )
      return owned
    }
    owned.close = callback => {
      callback(Object.assign(new Error("different cleanup fault"), { code: "EACCES" }))
      return owned
    }
    return owned
  }
  try {
    await assert.rejects(broker.listen(), /owned listen fault/)
    await assert.rejects(broker.close(), error => {
      assert.ok(error instanceof AggregateError)
      assert.ok(error.errors.some(item => item.code === "EACCES"))
      return true
    })
    assert.equal(fs.existsSync(broker.directory), false)
  } finally {
    net.createServer = createServer
  }
})

test("default observation cannot be promoted to a restart by a forged transport violation label", async () => {
  const events = []
  const broker = new RuntimeBroker(parseSettings({}), 1, "audit-only", (type, event) =>
    events.push({ type, event }),
  )
  const send = () => {},
    close = () => {}
  try {
    broker.receiveNative(
      "test",
      {
        type: "runtime-hello",
        version: 1,
        token: broker.manifest.token,
        runtimeId: "audit-source",
      },
      send,
      close,
    )
    for (const event of [
      { kind: "process", operation: "execSync", target: "node", action: "restart" },
      {
        kind: "process",
        operation: "execSync",
        target: "node",
        action: "restart",
        ruleId: "invented",
      },
      {
        kind: "integrity",
        operation: "protected-target-change",
        target: "Bot.em",
        action: "restart",
      },
      {
        kind: "runtime",
        operation: "runtime-bootstrap-failed",
        target: "worker",
        action: "restart",
      },
    ])
      broker.receiveNative("test", { type: "violation", event }, send, close)
    assert.equal(events.length, 5)
    assert.equal(
      events.every(row => row.type === "audit" && row.event.action === "audit"),
      true,
    )
    assert.equal(
      events.some(row => row.event.ruleId !== undefined),
      false,
    )
  } finally {
    await broker.close()
  }
})

test(
  "runtime broker forwards violations and rejects management commands and wrong credentials",
  { timeout: 10000 },
  async () => {
    const events = []
    const broker = new RuntimeBroker(
      parseSettings({
        rules: [
          {
            id: "configured-exec",
            kind: "process",
            operation: "execSync",
            target: "probe",
            action: "restart",
          },
        ],
      }),
      1,
      "test-project",
      (type, event) => events.push({ type, event }),
    )
    await broker.listen()
    const sockets = []
    async function connect() {
      const socket = net.connect(broker.manifest.endpoint)
      sockets.push(socket)
      socket.on("error", () => {})
      await once(socket, "connect")
      return socket
    }
    try {
      const wrong = await connect()
      const rejected = once(wrong, "close")
      wrong.write(
        JSON.stringify({ type: "runtime-hello", version: 1, token: "wrong", runtimeId: "wrong" }) +
          "\n",
      )
      await rejected
      assert.equal(events.length, 0)
      const socket = await connect()
      const ready = once(socket, "data")
      socket.write(
        JSON.stringify({
          type: "runtime-hello",
          version: 1,
          token: broker.manifest.token,
          runtimeId: "owned-node",
        }) + "\n",
      )
      assert.equal(JSON.parse(String((await ready)[0])).type, "runtime-ready")
      assert.equal(broker.activeRuntimes, 1)
      socket.write(
        JSON.stringify({
          type: "violation",
          event: {
            kind: "process",
            operation: "execSync",
            target: "node",
            action: "restart",
            ruleId: "configured-exec",
            details: { argumentsRedacted: true },
          },
        }) + "\n",
      )
      const violation = {
        kind: "process",
        operation: "execSync",
        target: "probe",
        action: "restart",
      }
      socket.write(JSON.stringify({ type: "violation", event: violation }) + "\n")
      await new Promise(resolve => setTimeout(resolve, 30))
      assert.ok(events.some(item => item.type === "audit" && item.event.target === "node"))
      assert.equal(
        events.some(item => item.type === "violation" && item.event.target === "node"),
        false,
      )
      assert.ok(events.some(item => item.type === "violation" && item.event.target === "probe"))
      const unicode = Buffer.from(
        JSON.stringify({
          type: "audit",
          event: {
            kind: "network",
            operation: "fetch",
            target: "https://example.test/中文路径",
            plugin: "中文插件",
          },
        }) + "\n",
      )
      const split = unicode.indexOf(Buffer.from("中文")) + 1
      socket.write(unicode.subarray(0, split))
      await new Promise(resolve => setTimeout(resolve, 10))
      socket.write(unicode.subarray(split))
      await new Promise(resolve => setTimeout(resolve, 30))
      assert.ok(
        events.some(
          item =>
            item.event.target === "https://example.test/中文路径" &&
            item.event.plugin === "中文插件",
        ),
      )
      const closed = once(socket, "close")
      socket.write(JSON.stringify({ type: "stop" }) + "\n")
      await closed
      assert.equal(broker.activeRuntimes, 0)
    } finally {
      for (const socket of sockets) socket.destroy()
      await broker.close()
      assert.equal(fs.existsSync(broker.directory), false)
    }
  },
)
