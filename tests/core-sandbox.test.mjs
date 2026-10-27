import assert from "node:assert/strict"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { readAuditRecords } from "./audit-reader.mjs"

const enabled = process.env.GUARD_TEST_CORE_SANDBOX === "1"
const supported = ["linux", "win32"].includes(process.platform)
const testsRoot = path.dirname(fileURLToPath(import.meta.url))
const repository = path.dirname(testsRoot)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(predicate, message, timeout = 60000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await pause(40)
  }
  throw new Error(message)
}

async function freePort() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

function processes() {
  if (process.platform === "win32") {
    const command =
      "@(Get-CimInstance Win32_Process | ForEach-Object { @{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; start = $_.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssfff') } }) | ConvertTo-Json -Compress"
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    ).trim()
    const values = output ? JSON.parse(output) : []
    return Array.isArray(values) ? values : [values]
  }
  const rows = []
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8")
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")
      if (!["Z", "X"].includes(fields[0]))
        rows.push({ pid: Number(entry), parent: Number(fields[1]), start: fields[19] })
    } catch {}
  }
  return rows
}

function scope(rootPid) {
  const rows = processes()
  const ids = new Set([rootPid])
  let changed
  do {
    changed = false
    for (const row of rows)
      if (ids.has(row.parent) && !ids.has(row.pid)) {
        ids.add(row.pid)
        changed = true
      }
  } while (changed)
  return rows.filter(row => ids.has(row.pid))
}

function assertGone(identities) {
  const now = processes()
  const leftovers = identities.filter(previous =>
    now.some(row => row.pid === previous.pid && row.start === previous.start),
  )
  assert.equal(leftovers.length, 0, "An old sandbox scope still contains a live process")
}

// 仅替换外部 Redis 依赖；本用例验证生命周期，不修改核心或开放 AppContainer 回环网络。
const redisFixture = `
import { EventEmitter } from "node:events"
export function createClient() {
  const values = new Map()
  const client = new EventEmitter()
  client.connect = async () => { client.isOpen = true; return client }
  client.disconnect = async () => { client.isOpen = false }
  client.quit = client.disconnect
  client.ping = async value => value ?? "PONG"
  client.get = async key => values.get(key) ?? null
  client.set = async (key, value) => { values.set(key, value); return "OK" }
  client.del = async key => Number(values.delete(key))
  client.save = async () => "OK"
  client.multi = () => { const multi = { incrBy() { return multi }, exec: async () => [] }; return multi }
  return client
}
`

function probePlugin() {
  return `
import fs from "node:fs"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { spawn } from "node:child_process"
export class GuardCoreSandboxProbe extends plugin {
  constructor() { super({ name: "Guard OS core fixture", rule: [] }) }
  init() {
    const command = path.resolve("data/guard-core-command.json")
    const script = path.resolve("plugins/guard-core-probe/violate.mjs")
    const timer = setInterval(() => {
      let request
      try { request = JSON.parse(fs.readFileSync(command, "utf8")) } catch { return }
      if (!["thread", "node-process"].includes(request.mode)) return
      fs.writeFileSync(command, JSON.stringify({ mode: "safe" }))
      const marker = path.resolve("data/" + request.mode + "-forbidden.txt")
      const attempted = path.resolve("data/" + request.mode + "-attempted.txt")
      if (request.mode === "thread") {
        const worker = new Worker(new URL("./violate.mjs", import.meta.url), { workerData: { marker, attempted } })
        worker.on("error", error => fs.appendFileSync(path.resolve("data/probe-errors.txt"), error.stack + "\\n"))
      } else {
        const child = spawn(process.execPath, [script, marker, attempted], { detached: true, stdio: "ignore" })
        child.on("error", error => fs.appendFileSync(path.resolve("data/probe-errors.txt"), error.stack + "\\n"))
        child.unref()
      }
    }, 100)
    this.addCleanup(() => clearInterval(timer))
  }
}
`
}

const violateSource = `
import fs from "node:fs"
import { workerData, isMainThread } from "node:worker_threads"
import { execFileSync } from "node:child_process"
const marker = isMainThread ? process.argv[2] : workerData.marker
const attempted = isMainThread ? process.argv[3] : workerData.attempted
try {
  execFileSync(process.execPath, ["-e", 'require("node:fs").writeFileSync(process.argv[1],"forbidden")', marker])
  fs.appendFileSync(attempted, "UNEXPECTED_ALLOWED\\n")
} catch (error) {
  fs.appendFileSync(attempted, error.code + "\\n")
}
setInterval(() => {}, 1000)
`

test(
  "formal supervisor runs unchanged core inside its OS sandbox and recovers nested-runtime violations",
  {
    skip: !enabled || !supported ? "requires GUARD_TEST_CORE_SANDBOX=1 on Windows or Linux" : false,
    timeout: 240000,
  },
  async context => {
    for (const item of ["source/app.js", "bundle/node_modules", "core-manifest.json"])
      assert.ok(
        fs.existsSync(path.join(testsRoot, item)),
        "Run tests/prepare.mjs before opting into core sandbox tests",
      )
    const runRoot = path.join(testsRoot, "runs", `core-sandbox-${process.platform}-${Date.now()}`)
    const root = path.join(runRoot, "project")
    fs.mkdirSync(runRoot, { recursive: true })
    fs.cpSync(path.join(testsRoot, "source"), root, { recursive: true, dereference: true })
    const modules = path.join(root, "node_modules")
    const bundle = path.join(testsRoot, "bundle/node_modules")
    const localModules = ["lodash", "md5", "node-fetch", "oicq"]
    fs.cpSync(bundle, modules, {
      recursive: true,
      dereference: true,
      filter: file =>
        !["redis", ...localModules].includes(path.relative(bundle, file).split(path.sep)[0]),
    })
    for (const name of localModules)
      fs.symlinkSync(
        path.join(root, "lib/modules", name),
        path.join(modules, name),
        process.platform === "win32" ? "junction" : "dir",
      )
    const redis = path.join(modules, "redis")
    fs.mkdirSync(redis, { recursive: true })
    fs.writeFileSync(
      path.join(redis, "package.json"),
      '{"name":"redis","type":"module","exports":"./index.js"}\n',
    )
    fs.writeFileSync(path.join(redis, "index.js"), redisFixture)
    const plugin = path.join(root, "plugins/yunzai-guard")
    fs.mkdirSync(plugin, { recursive: true })
    fs.copyFileSync(path.join(repository, "index.js"), path.join(plugin, "index.js"))
    fs.cpSync(path.join(repository, "dist"), path.join(plugin, "dist"), {
      recursive: true,
      dereference: true,
    })
    fs.cpSync(path.join(repository, "native"), path.join(plugin, "native"), {
      recursive: true,
      dereference: true,
    })
    const probe = path.join(root, "plugins/guard-core-probe")
    fs.mkdirSync(probe, { recursive: true })
    fs.writeFileSync(path.join(probe, "index.js"), probePlugin())
    fs.writeFileSync(path.join(probe, "violate.mjs"), violateSource)
    for (const directory of ["renderers", "temp", "logs", "config/config", "data/yunzai-guard"])
      fs.mkdirSync(path.join(root, directory), { recursive: true })
    const port = await freePort()
    fs.writeFileSync(
      path.join(root, "config/config/server.yaml"),
      `port: ${port}\nurl: http://127.0.0.1:${port}\nauth: {}\n`,
    )
    fs.writeFileSync(
      path.join(root, "config/config/redis.yaml"),
      "host: 127.0.0.1\nport: 6379\ndb: 0\n",
    )
    fs.writeFileSync(
      path.join(root, "config/config/bot.yaml"),
      "file_watch: false\nlog_level: trace\nplugin_load_timeout: 15\n",
    )
    fs.writeFileSync(path.join(root, "config/config/other.yaml"), "master: []\nmasterQQ: []\n")
    const state = path.join(root, "data/yunzai-guard")
    fs.writeFileSync(
      path.join(state, "settings.json"),
      JSON.stringify({
        schemaVersion: 1,
        controlPort: await freePort(),
        isolationMode: "os-sandbox",
        sandbox: { network: "none" },
        startupTimeout: 45000,
        handshakeTimeout: 15000,
        shutdownTimeout: 1500,
        recovery: { maxRestarts: 2, windowMs: 60000, baseDelayMs: 50, maxDelayMs: 100 },
        rules: [
          { id: "core-nested-exec", kind: "process", operation: "execFileSync", action: "restart" },
        ],
        audit: { maxEventsPerSecond: 1000 },
      }),
    )
    const commandPath = path.join(root, "data/guard-core-command.json")
    fs.writeFileSync(commandPath, '{"mode":"safe"}')
    const checks = []
    const check = name => {
      checks.push({ name, status: "passed" })
      context.diagnostic(`PASS ${name}`)
    }
    const events = () => readAuditRecords(state)
    const request = command => {
      const credential = JSON.parse(fs.readFileSync(path.join(state, "control.json"), "utf8"))
      return new Promise((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port: credential.port })
        let input = ""
        socket.setTimeout(5000, () => socket.destroy(new Error("Test control timeout")))
        socket.on("error", reject)
        socket.on("connect", () =>
          socket.write(JSON.stringify({ token: credential.token, command }) + "\n"),
        )
        socket.on("data", chunk => {
          input += chunk
          if (input.includes("\n")) {
            socket.end()
            resolve(JSON.parse(input.split("\n")[0]))
          }
        })
      })
    }
    async function online(minimumGeneration = 1) {
      let current
      await until(async () => {
        try {
          current = await request("status")
          return (
            current.phase === "tripped" ||
            (current.phase === "online" && current.generation >= minimumGeneration)
          )
        } catch {
          return false
        }
      }, "Sandbox core did not reach online; inspect the isolated process-output.log")
      assert.notEqual(
        current.phase,
        "tripped",
        `Sandbox core initialization tripped: ${current.trippedReason}`,
      )
      return current
    }
    const cli = command =>
      JSON.parse(
        execFileSync(process.execPath, [path.join(plugin, "dist/cli.js"), command], {
          cwd: root,
          encoding: "utf8",
          windowsHide: true,
          timeout: 10000,
        }),
      )
    const output = fs.createWriteStream(path.join(runRoot, "process-output.log"))
    const env = { ...process.env }
    delete env.NODE_OPTIONS
    delete env.app_type
    const host = spawn(process.execPath, [path.join(plugin, "dist/launcher.js")], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    host.stdout.pipe(output, { end: false })
    host.stderr.pipe(output, { end: false })
    const owned = []
    try {
      let current = await online()
      assert.equal(current.hostPid, host.pid)
      assert.equal(current.capabilities.osSandbox, true)
      check("formal supervisor launches real unchanged app.js in os-sandbox mode")
      for (const command of ["invoke-bot-restart", "restart"]) {
        const previous = current
        const previousScope = scope(previous.workerPid)
        assert.ok(
          previousScope.length >= 2,
          "Expected a native sandbox launcher and its managed process",
        )
        owned.push(...previousScope)
        if (command === "restart") cli("restart")
        else await request(command)
        current = await online(previous.generation + 1)
        assert.equal(current.hostPid, host.pid)
        assert.equal(current.generation, previous.generation + 1)
        assertGone(previousScope)
      }
      check("Bot.restart and actual CLI restart preserve host and terminate the previous OS scope")
      for (const kind of ["thread", "node-process"]) {
        const previous = current
        const previousScope = scope(previous.workerPid)
        owned.push(...previousScope)
        fs.writeFileSync(commandPath, JSON.stringify({ mode: kind }))
        await until(
          () => fs.existsSync(path.join(root, `data/${kind}-attempted.txt`)),
          "Nested probe did not execute",
        )
        current = await online(previous.generation + 1)
        assert.equal(current.hostPid, host.pid)
        assertGone(previousScope)
        assert.equal(fs.existsSync(path.join(root, `data/${kind}-forbidden.txt`)), false)
        assert.match(
          fs.readFileSync(path.join(root, `data/${kind}-attempted.txt`), "utf8"),
          /GUARD_DENIED/,
        )
        assert.ok(
          events().some(
            event =>
              event.type === "violation" &&
              event.event?.operation === "execFileSync" &&
              event.event?.runtime?.kind === kind,
          ),
          "Nested runtime violation did not reach the authoritative supervisor log",
        )
        check(
          `${kind} internal violation is blocked before its marker and recovers through the formal host`,
        )
      }
      owned.push(...scope(current.workerPid))
      fs.writeFileSync(commandPath, '{"mode":"thread"}')
      let tripped
      await until(async () => {
        tripped = await request("status")
        return tripped.phase === "tripped"
      }, "Repeated violations did not trip recovery")
      assert.equal(tripped.workerPid, undefined)
      assertGone(owned)
      check("repeated nested violations exhaust recovery and leave only the tripped supervisor")
      cli("resume")
      current = await online(tripped.generation + 1)
      assert.equal(current.hostPid, host.pid)
      check("manual resume resets the latch and brings the corrected safe fixture online")
      const lastScope = scope(current.workerPid)
      owned.push(...lastScope)
      cli("stop")
      await until(() => host.exitCode !== null, "Stop did not terminate the supervisor")
      assert.equal(host.exitCode, 0)
      assertGone(owned)
      check(
        "stop terminates the managed OS scope and the supervisor without residual owned processes",
      )
      const active = new Set()
      for (const event of events()) {
        if (event.type === "worker-spawn") {
          assert.equal(active.size, 0)
          active.add(event.workerPid)
        }
        if (event.type === "worker-exit") active.delete(event.workerPid)
      }
      assert.equal(active.size, 0)
      check("authoritative lifecycle timeline contains no overlapping managed generations")
      const hashes = JSON.parse(fs.readFileSync(path.join(testsRoot, "core-manifest.json"), "utf8"))
      for (const [file, expected] of Object.entries(hashes))
        assert.equal(
          createHash("sha256")
            .update(fs.readFileSync(path.join(root, file)))
            .digest("hex"),
          expected,
          `Core changed: ${file}`,
        )
      assert.equal(Object.keys(hashes).length, 47)
      check("all 47 original core files remain byte-identical")
      fs.writeFileSync(
        path.join(runRoot, "report.json"),
        JSON.stringify(
          {
            platform: process.platform,
            arch: process.arch,
            node: process.version,
            isolationMode: "os-sandbox",
            network: "none",
            redisFixture:
              "in-memory EventEmitter dependency stub; no production Redis or loopback exemption",
            dependencyLayout: "offline bundle fully copied inside project, no external symlinks",
            checks,
          },
          null,
          2,
        ) + "\n",
      )
    } catch (error) {
      fs.writeFileSync(path.join(runRoot, "failure.txt"), error.stack)
      throw error
    } finally {
      try {
        if (host.exitCode === null) await request("stop")
      } catch {}
      await until(
        () => host.exitCode !== null || host.signalCode !== null,
        "Graceful test host cleanup timed out",
        15000,
      ).catch(() => {
        if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL")
      })
      await until(
        () => host.exitCode !== null || host.signalCode !== null,
        "Test host failed to exit",
        15000,
      )
      output.end()
      context.diagnostic(`Evidence: ${runRoot}`)
    }
  },
)
