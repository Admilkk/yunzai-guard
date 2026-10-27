import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { spawn } from "node:child_process"
import { performance } from "node:perf_hooks"
import test from "node:test"
import { executeNativeRedis } from "../dist/native-sandbox/redis.js"
import { parseNativeRedisPermissions } from "../dist/native-sandbox/config.js"

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const enabled =
  process.platform === "linux" &&
  process.env.GUARD_ECOSYSTEM_CONTAINER === "1" &&
  process.env.GUARD_TEST_NATIVE_REDIS === "1"
test(
  "a dedicated real Redis instance retains original keys before, during and after the Guard broker",
  {
    skip: enabled ? false : "requires isolated Linux container and GUARD_TEST_NATIVE_REDIS=1",
    timeout: 30000,
  },
  async t => {
    const runs = path.join(repository, "tests/runs"),
      base = process.env.GUARD_NATIVE_PROBE_ROOT || runs
    fs.mkdirSync(runs, { recursive: true })
    fs.mkdirSync(base, { recursive: true })
    const root = fs.mkdtempSync(path.join(base, "redis-original-")),
      socket = path.join(root, "redis.sock")
    assert.ok(
      Buffer.byteLength(socket) < 104,
      "Redis fixture requires a short private Unix socket path",
    )
    const dependencies = process.env.GUARD_ECOSYSTEM_DEPENDENCIES
    assert.ok(
      dependencies,
      "GUARD_ECOSYSTEM_DEPENDENCIES must name the fixture node_modules directory",
    )
    const require = createRequire(import.meta.url)
    const { createClient } = require(require.resolve("redis", { paths: [dependencies] }))
    const server = spawn(
      process.env.GUARD_REDIS_SERVER || "/usr/bin/redis-server",
      [
        "--port",
        "0",
        "--save",
        "",
        "--appendonly",
        "no",
        "--unixsocket",
        socket,
        "--unixsocketperm",
        "700",
        "--dir",
        root,
        "--daemonize",
        "no",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    let output = "",
      client,
      launchError
    server.on("error", error => {
      launchError = error
    })
    for (const stream of [server.stdout, server.stderr])
      stream.on("data", chunk => {
        output = (output + chunk).slice(-8192)
      })
    const report = {
      fixture: root,
      transport: "private Unix socket",
      standaloneRedisPid: server.pid,
      originalKey: "Business:state",
      before: null,
      after: null,
      postUninstallDirectRead: null,
      allKeys: [],
      passed: false,
    }
    const reportPath = path.join(runs, `native-redis-${path.basename(root)}.json`)
    try {
      const deadline = performance.now() + 10000
      while (
        !fs.existsSync(socket) &&
        performance.now() < deadline &&
        !launchError &&
        server.exitCode === null
      )
        await new Promise(resolve => setTimeout(resolve, 20))
      if (launchError) throw launchError
      assert.ok(fs.existsSync(socket), output)
      client = createClient({
        socket: { path: socket, connectTimeout: 1000, reconnectStrategy: false },
      })
      client.on("error", () => {})
      await client.connect()
      await client.set("Business:state", "before-guard")
      await client.set("peer:state", "unchanged")
      const permissions = parseNativeRedisPermissions({
        read: ["Business:*"],
        write: ["Business:*"],
      })
      report.before = await executeNativeRedis(client, permissions, "get", ["Business:state"])
      assert.equal(report.before, "before-guard")
      await executeNativeRedis(client, permissions, "set", [
        "Business:state",
        "sandbox-updated",
        { EX: 60 },
      ])
      report.after = await executeNativeRedis(client, permissions, "get", ["Business:state"])
      assert.equal(report.after, "sandbox-updated")
      await assert.rejects(
        executeNativeRedis(client, permissions, "del", [["Business:state", "peer:state"]]),
        error => error.code === "NATIVE_REDIS_DENIED",
      )
      await executeNativeRedis(client, permissions, "zAdd", [
        "Business:rank",
        [
          { score: 1, value: "one" },
          { score: 2, value: "two" },
        ],
      ])
      assert.deepEqual(
        await executeNativeRedis(client, permissions, "zRange", [
          "Business:rank",
          0,
          9,
          { REV: true },
        ]),
        ["two", "one"],
      )
      assert.deepEqual(
        await executeNativeRedis(client, permissions, "zRangeWithScores", [
          "Business:rank",
          "-inf",
          "+inf",
          { BY: "SCORE", LIMIT: { offset: 0, count: 10 } },
        ]),
        [
          { value: "one", score: 1 },
          { value: "two", score: 2 },
        ],
      )
      assert.equal(
        await executeNativeRedis(client, permissions, "zRevRank", ["Business:rank", "two"]),
        0,
      )
      assert.equal(
        await executeNativeRedis(client, permissions, "zRem", ["Business:rank", "one"]),
        1,
      )
      assert.deepEqual(
        (await executeNativeRedis(client, permissions, "keys", ["Business:*"])).sort(),
        ["Business:rank", "Business:state"],
      )
      await client.set("Business:oversized", "x".repeat(65537))
      await assert.rejects(
        executeNativeRedis(client, permissions, "get", ["Business:oversized"]),
        error => error.code === "NATIVE_REDIS_DENIED",
      )
      await client.del("Business:oversized")
      // 直接访问模拟移除 Guard 代理后的行为，Redis 服务和数据保持一致。
      report.postUninstallDirectRead = await client.get("Business:state")
      assert.equal(report.postUninstallDirectRead, "sandbox-updated")
      assert.equal(await client.get("peer:state"), "unchanged")
      report.allKeys = (await client.keys("*")).sort() // 仅枚举本次新建的私有测试数据库。
      assert.deepEqual(report.allKeys, ["Business:rank", "Business:state", "peer:state"])
      report.passed = true
    } finally {
      try {
        if (client?.isOpen) await client.quit()
      } finally {
        if (server.exitCode === null && server.signalCode === null) {
          const ended = new Promise(resolve => server.once("exit", resolve))
          server.kill("SIGTERM")
          let timer
          try {
            await Promise.race([
              ended,
              new Promise(resolve => {
                timer = setTimeout(() => {
                  server.kill("SIGKILL")
                  resolve()
                }, 3000)
              }),
            ])
          } finally {
            clearTimeout(timer)
          }
          if (server.exitCode === null && server.signalCode === null) await ended
        }
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
        t.diagnostic(`Dedicated Redis evidence: ${reportPath}; fixture retained at ${root}`)
      }
    }
  },
)
