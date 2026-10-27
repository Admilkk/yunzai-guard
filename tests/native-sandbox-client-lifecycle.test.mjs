import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { NativePluginClient } from "../dist/native-sandbox/client.js"
import {
  launchNativeSandbox,
  nativeStartupCleanupConfirmed,
} from "../dist/native-sandbox/launch.js"
import { parseSettings } from "../dist/config/index.js"

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function fixture(t) {
  const runs = path.join(repository, "tests/runs")
  fs.mkdirSync(runs, { recursive: true })
  const root = fs.mkdtempSync(path.join(runs, "native-client-lifecycle-"))
  fs.mkdirSync(path.join(root, "plugins/sandboxed"), { recursive: true })
  const settings = parseSettings({
    pluginSandbox: { native: { plugins: [{ id: "sandboxed", timeoutMs: 1000 }] } },
  })
  const replies = [],
    redisCalls = [],
    handlerRejections = [],
    outgoing = [],
    audits = []
  let closed = 0
  const client = new NativePluginClient(
    root,
    settings.pluginSandbox.native.plugins[0],
    settings,
    event => audits.push(event),
    () => ({
      get: key => {
        redisCalls.push(key)
        return Promise.resolve("value")
      },
    }),
  )
  // 注入已握手的模拟会话，验证真实请求、服务和关闭逻辑，不启动系统进程。
  client.session = {
    platform: process.platform === "win32" ? "win32" : "linux",
    child: {
      connected: true,
      pid: 1,
      send(frame, callback) {
        outgoing.push(frame)
        callback?.(null)
        return true
      },
    },
    async close() {
      closed++
    },
  }
  client.readyPromise = Promise.resolve()
  client.applicationReady = true
  client.events.set("active-event", {
    reply: (...args) => {
      replies.push(args)
      return { message_id: "test" }
    },
  })
  client.capabilities.set("active-event", {
    handlerReject: message => {
      handlerRejections.push(message)
    },
  })
  t.after(() => {
    const resolved = fs.realpathSync.native(root)
    if (
      path.dirname(resolved) !== fs.realpathSync.native(runs) ||
      !path.basename(resolved).startsWith("native-client-lifecycle-")
    )
      throw new Error("Refusing unsafe lifecycle fixture cleanup")
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  return { client, replies, redisCalls, handlerRejections, outgoing, audits, closed: () => closed }
}

test("启动失败已确认回收时只关闭选中插件，不误报系统范围未知", async t => {
  const f = fixture(t)
  let startupError
  await assert.rejects(
    launchNativeSandbox({
      root: path.join(f.client.root, "missing-project"),
      pluginRoot: f.client.pluginRoot,
      entry: "unused",
      network: "none",
    }),
    error => {
      startupError = error
      return nativeStartupCleanupConfirmed(error)
    },
  )
  f.client.session = undefined
  f.client.applicationReady = false
  f.client.failed = startupError
  f.client.launchPromise = Promise.reject(startupError)
  await f.client.close()
  assert.equal(f.client.failed, startupError)
  assert.equal(f.closed(), 0)
  assert.equal(
    f.audits.some(event => event.operation === "native.cleanup-unconfirmed"),
    false,
  )
})

test("未知启动范围不能通过伪造错误属性跳过回收失败", async t => {
  const f = fixture(t)
  const error = Object.assign(new Error("unknown startup scope"), { cleanupConfirmed: true })
  assert.equal(nativeStartupCleanupConfirmed(error), false)
  f.client.session = undefined
  f.client.applicationReady = false
  f.client.launchPromise = Promise.reject(error)
  await assert.rejects(f.client.close(), caught => caught === error)
  assert.equal(f.audits.filter(event => event.operation === "native.cleanup-unconfirmed").length, 1)
  assert.equal(
    f.audits.find(event => event.operation === "native.cleanup-unconfirmed").action,
    "restart",
  )
})

test("adapter registration cleanup failure cannot skip mandatory OS teardown", async t => {
  const f = fixture(t)
  f.client.applicationReady = false
  f.client.adapterHost = {
    close() {
      throw new Error("fixture host cleanup failed")
    },
  }
  await assert.rejects(f.client.close(), /fixture host cleanup failed/)
  assert.equal(f.closed(), 1)
  assert.equal(f.client.events.size, 0)
  assert.equal(f.client.capabilities.size, 0)
})

for (const service of ["event", "redis", "handlerReject"]) {
  test(`retiring a native client revokes ${service} service before guest disposal completes`, async t => {
    const f = fixture(t)
    const closing = f.client.close()
    // 让真实 dispose 请求到达模拟会话，并故意不返回结果。
    await new Promise(resolve => setImmediate(resolve))
    const dispose = f.outgoing.find(frame => frame.type === "native-dispose")
    try {
      assert.ok(dispose, "Graceful disposal must actually be in flight")
      assert.equal(f.closed(), 0, "The OS scope has not yet been torn down")
      const frame =
        service === "event"
          ? {
              type: "native-service",
              id: "1",
              service: "event",
              method: "reply",
              requestId: "active-event",
              args: ["late reply"],
            }
          : service === "handlerReject"
            ? {
                type: "native-service",
                id: "1",
                service: "event",
                method: "handlerReject",
                requestId: "active-event",
                args: ["late rejection"],
              }
            : {
                type: "native-service",
                id: "1",
                service: "redis",
                method: "get",
                args: ["late-read"],
              }
      await f.client.service(frame).catch(() => {})
      assert.deepEqual(f.replies, [], "No reply capability survives the start of retirement")
      assert.deepEqual(f.redisCalls, [], "Retirement must not dispatch new Redis work")
      assert.deepEqual(f.handlerRejections, [], "Retirement must not dispatch a Handler rejection")
      assert.equal(f.closed(), 0, "Service rejection must not prevent the pending cleanup reply")
    } finally {
      if (dispose)
        f.client.receive({
          type: "native-result",
          requestId: dispose.requestId,
          ok: true,
          value: { disposed: 1, failed: 0 },
        })
      await closing
    }
    assert.equal(f.closed(), 1)
  })
}
