import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { promisify } from "node:util"
import test from "node:test"
import { createEnvironmentFixture, snapshot, until, waitScopeGone } from "./environment-fixture.mjs"
import { environmentDigest } from "./pm2-windows-fixture.mjs"

// 通配调试端点仅在专用离线容器内创建，不能只凭启用标记在开发宿主上开放。
const enabled =
  process.platform === "linux" &&
  process.env.GUARD_TEST_PM2_INSPECTOR_CONTAINER === "1" &&
  process.env.GUARD_TEST_PM2_AUTO === "1"
const execute = promisify(execFile)
const read = file => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "")
const hashFile = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
const pm2Root = process.env.GUARD_TEST_PM2_PACKAGE || "/usr/local/lib/node_modules/pm2"
function hashes(directory, prefix = "") {
  const result = {}
  for (const entry of fs.readdirSync(path.join(directory, prefix), { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(entry.name)) continue
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory()) Object.assign(result, hashes(directory, relative))
    else if (entry.isFile()) result[relative] = hashFile(path.join(directory, relative))
  }
  return result
}
function state(row) {
  assert.ok(row)
  return {
    id: row.pm_id,
    pid: row.pid,
    status: row.pm2_env.status,
    restarts: row.pm2_env.restart_time,
    script: row.pm2_env.pm_exec_path,
    env: environmentDigest(row.pm2_env.env),
  }
}
async function ownedEndpoint(log) {
  return until(
    () => {
      const matches = [...read(log).matchAll(/Debugger listening on (ws:\/\/[^\s]+)/g)]
      return matches.at(-1)?.[1]
    },
    "Owned daemon did not open an Inspector endpoint",
    15000,
  )
}
async function discover(url) {
  const parsed = new URL(url)
  const response = await fetch(`http://127.0.0.1:${parsed.port}/json/list`, {
    signal: AbortSignal.timeout(1000),
    redirect: "error",
  })
  return response.json()
}
async function client(url) {
  const parsed = new URL(url)
  parsed.hostname = "127.0.0.1"
  const socket = new WebSocket(parsed)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Owned Runtime client connection timeout")),
      5000,
    )
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer)
        reject(new Error("Owned Runtime client failed"))
      },
      { once: true },
    )
  })
  let id = 0
  return {
    socket,
    ping() {
      const serial = ++id
      return new Promise((resolve, reject) => {
        const finish = (error, value) => {
          clearTimeout(timer)
          socket.removeEventListener("message", message)
          socket.removeEventListener("close", close)
          error ? reject(error) : resolve(value)
        }
        const close = () => finish(new Error("Pre-existing Runtime client was disconnected"))
        const message = event => {
          const reply = JSON.parse(event.data)
          if (reply.id === serial)
            reply.error
              ? finish(new Error("Owned heartbeat failed"))
              : finish(undefined, reply.result?.result?.value)
        }
        const timer = setTimeout(() => finish(new Error("Owned Runtime heartbeat timed out")), 5000)
        socket.addEventListener("message", message)
        socket.addEventListener("close", close, { once: true })
        socket.send(
          JSON.stringify({
            id: serial,
            method: "Runtime.evaluate",
            params: { expression: "process.pid", returnByValue: true },
          }),
        )
      })
    },
  }
}

for (const scenario of ["hidden-new-wildcard", "existing-wildcard"])
  test(
    `Linux isolated PM2 Inspector refuses ${scenario}`,
    {
      skip: enabled ? false : "requires explicit offline Inspector container gate",
      timeout: 180000,
    },
    async context => {
      // 绑定通配端点前核对实际命名空间，不能只检查环境变量。
      assert.ok(fs.existsSync("/.dockerenv"), "Wildcard Inspector tests require Docker")
      assert.deepEqual(fs.readdirSync("/sys/class/net").sort(), ["lo"], "Use --network none")
      const fixture = await createEnvironmentFixture({ mode: "managed", label: "pm2i" })
      const home = path.join(fixture.runRoot, "pm2-home")
      const daemonLog = path.join(home, "pm2.log")
      const defaultHome = process.env.PM2_HOME || path.join(process.env.HOME || "", ".pm2")
      const defaultPid = read(path.join(defaultHome, "pm2.pid"))
      const expectedSources = hashes(pm2Root)
      const actualDist = hashes(path.join(fixture.pluginDir, "dist"))
      for (const directory of [
        home,
        path.join(home, "logs"),
        path.join(home, "pids"),
        path.join(home, "modules"),
      ])
        fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(home, "module_conf.json"), "{}\n")
      fs.writeFileSync(path.join(home, "touch"), "test-owned\n")
      const env = { ...process.env, PM2_HOME: home, PM2_NO_INTERACTION: "true", NO_COLOR: "1" }
      for (const key of [
        "NODE_OPTIONS",
        "PM2_NODE_OPTIONS",
        "pm_id",
        "NODE_APP_INSTANCE",
        "app_type",
      ])
        delete env[key]
      const resident = path.join(fixture.runRoot, "resident.cjs")
      fs.writeFileSync(
        resident,
        'setInterval(()=>{},1000);process.on("message",v=>{if(v==="shutdown")process.exit(0)});process.send?.("ready")\n',
      )
      const otherConfig = path.join(fixture.runRoot, "resident.config.cjs")
      const targetConfig = path.join(fixture.runRoot, "original.config.cjs")
      fs.writeFileSync(
        otherConfig,
        "module.exports=" +
          JSON.stringify({
            apps: [
              {
                name: "unrelated",
                script: resident,
                wait_ready: true,
                shutdown_with_message: true,
                filter_env: ["NODE_OPTIONS", "PM2_NODE_OPTIONS"],
              },
            ],
          }) +
          "\n",
      )
      fs.writeFileSync(
        targetConfig,
        "module.exports=" +
          JSON.stringify({
            apps: [
              {
                name: "guard-negative",
                script: path.join(fixture.root, "app.js"),
                cwd: fixture.root,
                instances: 1,
                exec_mode: "fork",
                stop_exit_codes: [78],
                filter_env: ["NODE_OPTIONS", "PM2_NODE_OPTIONS"],
                env: { app_type: "pm2" },
                error_file: path.join(fixture.runRoot, "application-error.log"),
                merge_logs: true,
              },
            ],
          }) +
          "\n",
      )
      const configHash = hashFile(targetConfig)
      let daemon, ownClient, failure, cleanupFailure, cleanup, unrelatedUnchanged, endpointReceipt
      const daemonIdentity = () => {
        const pid = Number(read(path.join(home, "pm2.pid")).trim())
        return snapshot(pid).find(row => row.pid === pid)
      }
      const cli = async args => {
        assert.deepEqual(daemonIdentity(), daemon, "Private daemon identity changed")
        const result = await execute(
          process.execPath,
          [path.join(pm2Root, "bin/pm2"), ...args, "--silent"],
          { env, cwd: fixture.root, timeout: 45000, maxBuffer: 4 * 1024 * 1024 },
        )
        if (args[0] !== "kill") assert.deepEqual(daemonIdentity(), daemon)
        return result.stdout.trim()
      }
      const list = async () => JSON.parse(await cli(["jlist"]))
      let child
      try {
        context.diagnostic(`Evidence: ${fixture.runRoot}`)
        const fd = fs.openSync(daemonLog, "a")
        child = spawn(
          process.execPath,
          [
            ...(scenario === "existing-wildcard" ? ["--inspect=0.0.0.0:0"] : []),
            path.join(pm2Root, "lib/Daemon.js"),
          ],
          {
            cwd: fixture.root,
            env: {
              ...env,
              ...(scenario === "hidden-new-wildcard"
                ? { NODE_OPTIONS: "--inspect-port=0.0.0.0:0" }
                : {}),
            },
            detached: true,
            stdio: ["ignore", fd, fd, "ipc"],
          },
        )
        fs.closeSync(fd)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Private daemon startup timeout")), 15000)
          child.once("error", error => {
            clearTimeout(timer)
            reject(error)
          })
          child.once("exit", () => {
            clearTimeout(timer)
            reject(new Error("Private daemon exited before ready"))
          })
          child.on("message", message => {
            if (message?.online && message.pid === child.pid) {
              clearTimeout(timer)
              child.disconnect()
              resolve()
            }
          })
        })
        child.unref()
        daemon = daemonIdentity()
        assert.equal(daemon?.pid, child.pid)
        let originalEndpoint
        if (scenario === "existing-wildcard") {
          originalEndpoint = await ownedEndpoint(daemonLog)
          ownClient = await client(originalEndpoint)
          assert.equal(await ownClient.ping(), daemon.pid)
        } else assert.doesNotMatch(read(daemonLog), /Debugger listening/)
        await cli(["start", otherConfig])
        const unrelated = state((await list()).find(row => row.name === "unrelated"))
        assert.equal(unrelated.status, "online")
        await cli(["start", targetConfig])
        const row = await until(
          async () => {
            const target = (await list()).find(row => row.name === "guard-negative")
            return target?.pm2_env.status === "stopped" && target.pm2_env.exit_code === 78 && target
          },
          "Unsupported Inspector target did not stop with exit 78",
          60000,
        )
        await until(
          () => /接管 PM2 应用失败/.test(read(path.join(fixture.runRoot, "application-error.log"))),
          "The exact PM2 application error log did not record its rejection",
          5000,
        )
        assert.equal(row.pm2_env.restart_time, 0)
        assert.equal(row.pm2_env.pm_exec_path, path.join(fixture.root, "app.js"))
        assert.equal(
          fixture.events().filter(event => event.type === "host-lock-acquired").length,
          0,
        )
        assert.doesNotMatch(read(daemonLog), /pm2-application-registered|pm2-handoff-requested/)
        assert.deepEqual(state((await list()).find(row => row.name === "unrelated")), unrelated)
        unrelatedUnchanged = true
        assert.deepEqual(daemonIdentity(), daemon)
        if (scenario === "hidden-new-wildcard") {
          const endpoint = await ownedEndpoint(daemonLog)
          await until(
            async () => {
              try {
                return !(await discover(endpoint)).some(item => item.type === "node")
              } catch {
                return true
              }
            },
            "New wildcard Inspector endpoint remained open",
            10000,
          )
          const port = Number(new URL(endpoint).port).toString(16).toUpperCase().padStart(4, "0")
          assert.ok(
            !read(`/proc/${daemon.pid}/net/tcp`)
              .split("\n")
              .some(
                line =>
                  line
                    .trim()
                    .split(/\s+/)[1]
                    ?.endsWith(":" + port) && line.trim().split(/\s+/)[3] === "0A",
              ),
          )
          endpointReceipt = "newly-opened-endpoint-closed"
        } else {
          assert.equal(await ownClient.ping(), daemon.pid)
          const targets = await discover(originalEndpoint)
          const originalId = new URL(originalEndpoint).pathname.slice(1)
          assert.ok(targets.some(target => target.id === originalId))
          endpointReceipt = "preexisting-endpoint-and-client-preserved"
        }
        fixture.verifyCoreHashes()
        assert.equal(hashFile(targetConfig), configHash)
        assert.deepEqual(hashes(pm2Root), expectedSources)
        assert.deepEqual(hashes(path.join(fixture.pluginDir, "dist")), actualDist)
      } catch (error) {
        failure = error
      } finally {
        ownClient?.socket.close()
        try {
          if (!daemon && child?.pid) daemon = snapshot(child.pid).find(row => row.pid === child.pid)
          if (daemon) {
            assert.deepEqual(daemonIdentity(), daemon)
            const scope = snapshot(daemon.pid)
            await cli(["kill"])
            await waitScopeGone(scope)
          }
          await fixture.finish({ stop: false })
          assert.equal(read(path.join(defaultHome, "pm2.pid")), defaultPid)
          fixture.verifyCoreHashes()
          cleanup = { confirmed: true, observedScopesGone: true, defaultDaemonUnchanged: true }
        } catch (error) {
          cleanupFailure = error
        }
        fs.writeFileSync(
          path.join(fixture.runRoot, "pm2-inspector-report.json"),
          JSON.stringify(
            {
              platform: process.platform,
              scenario,
              status: failure || cleanupFailure ? "failed" : "passed",
              networkNamespace: "none",
              operatorGuardPreload: false,
              sourceSnapshot: {
                guardDistHashes: actualDist,
                pm2SourceDigest: environmentDigest(expectedSources),
              },
              endpointReceipt,
              unrelatedUnchanged,
              coreFileHashCount: 47,
              redisFixture: fixture.redisFixture,
              cleanup,
              error: failure?.stack,
              cleanupError: cleanupFailure?.stack,
            },
            null,
            2,
          ) + "\n",
        )
      }
      if (failure && cleanupFailure) throw new AggregateError([failure, cleanupFailure])
      if (failure) throw failure
      if (cleanupFailure) throw cleanupFailure
    },
  )
