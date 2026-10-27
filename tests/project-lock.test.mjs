import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { createHash } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"
import {
  acquireProjectLock,
  assertNoPreviousHost,
  excludedPortRanges,
  legacyProjectPort,
  windowsProjectPipe,
  onlyNonListeningConnections,
} from "../dist/host/lock.js"

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const error = code => Object.assign(new Error(code), { code })

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "guard-project-lock-"))
  const state = path.join(root, "data/yunzai-guard")
  fs.mkdirSync(state, { recursive: true })
  const canonical = fs.realpathSync.native(root)
  const projectId = createHash("sha256")
    .update(process.platform === "win32" ? canonical.toLowerCase() : canonical)
    .digest("hex")
    .slice(0, 16)
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync.native(root)), fs.realpathSync.native(os.tmpdir()))
    assert.match(path.basename(root), /^guard-project-lock-/)
    fs.rmSync(root, { recursive: true, force: true })
  })
  const controlPath = path.join(state, "control.json")
  const identity = { projectId, hostPid: 2147483646, port: 12345, token: "a".repeat(48) }
  return {
    root,
    state,
    projectId,
    controlPath,
    identity,
    write: value => fs.writeFileSync(controlPath, JSON.stringify(value)),
  }
}

function fakeBindings(failure = "EACCES") {
  const servers = []
  return {
    servers,
    listen: async endpoint => {
      if (typeof endpoint === "number") throw error(failure)
      const server = {
        listening: true,
        close(callback) {
          this.listening = false
          callback()
        },
      }
      servers.push(server)
      return server
    },
  }
}

test("project lock identity is independent of the control port and netsh parsing is bounded", () => {
  assert.equal(legacyProjectPort("0123456789abcdef"), 40000 + (0x012345 % 20000))
  assert.equal(
    windowsProjectPipe("0123456789abcdef"),
    "\\\\.\\pipe\\yunzai-guard-project-0123456789abcdef",
  )
  assert.throws(() => windowsProjectPipe("../invalid"))
  assert.deepEqual(
    excludedPortRanges("起始端口 结束端口\r\n   50000   50059   *\r\n 5357 5357\n"),
    [
      [50000, 50059],
      [5357, 5357],
    ],
  )
  assert.deepEqual(excludedPortRanges("Error 5: Access denied\n"), [])
  assert.throws(() => excludedPortRanges(" 65535 65536\n"))
  assert.throws(() => excludedPortRanges("x".repeat(65537)))
})

test("an authenticated old host is refused without changing its credential", async t => {
  const f = fixture(t)
  f.write(f.identity)
  const original = fs.readFileSync(f.controlPath)
  await assert.rejects(
    assertNoPreviousHost(f.controlPath, f.projectId, {
      queryStatus: async supplied => {
        assert.deepEqual(supplied, f.identity)
        return { projectId: f.projectId, hostPid: f.identity.hostPid, phase: "online" }
      },
    }),
    { code: "PROJECT_ALREADY_RUNNING" },
  )
  assert.deepEqual(fs.readFileSync(f.controlPath), original)
})

test("old-host status authentication is checked over the real loopback protocol", async t => {
  const f = fixture(t)
  let authenticated = false
  const server = net.createServer(socket =>
    socket.once("data", bytes => {
      const request = JSON.parse(bytes)
      assert.equal(request.token, f.identity.token)
      assert.equal(request.command, "status")
      authenticated = true
      socket.end(
        JSON.stringify({ projectId: f.projectId, hostPid: process.pid, phase: "online" }) + "\n",
      )
    }),
  )
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  try {
    f.write({ ...f.identity, port: server.address().port, hostPid: process.pid })
    await assert.rejects(acquireProjectLock(f), { code: "PROJECT_ALREADY_RUNNING" })
    assert.equal(authenticated, true)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test("only a dead prior PID plus refused endpoint makes a valid credential stale", async t => {
  const f = fixture(t)
  assert.equal(await assertNoPreviousHost(f.controlPath, f.projectId), "absent")
  f.write(f.identity)
  assert.equal(
    await assertNoPreviousHost(f.controlPath, f.projectId, {
      queryStatus: async () => {
        throw error("ECONNREFUSED")
      },
      processAlive: () => false,
    }),
    "stale",
  )
  for (const dependencies of [
    {
      queryStatus: async () => {
        throw error("ECONNREFUSED")
      },
      processAlive: () => true,
    },
    {
      queryStatus: async () => {
        throw error("ECONNREFUSED")
      },
      processAlive: () => {
        throw error("EPERM")
      },
    },
    {
      queryStatus: async () => {
        throw error("ETIMEDOUT")
      },
      processAlive: () => false,
    },
    { queryStatus: async () => ({ hostPid: f.identity.hostPid, projectId: "f".repeat(16) }) },
    { queryStatus: async () => ({ hostPid: f.identity.hostPid + 1, projectId: f.projectId }) },
  ])
    await assert.rejects(assertNoPreviousHost(f.controlPath, f.projectId, dependencies), {
      code: "PREVIOUS_HOST_UNCONFIRMED",
    })
})

test("malformed, forged, oversized and linked prior control files fail closed", async t => {
  const f = fixture(t)
  for (const value of [
    null,
    [],
    { ...f.identity, projectId: "b".repeat(16) },
    { ...f.identity, token: "guess" },
    { ...f.identity, port: 0 },
    { ...f.identity, hostPid: 0 },
  ]) {
    f.write(value)
    await assert.rejects(assertNoPreviousHost(f.controlPath, f.projectId), {
      code: "PREVIOUS_HOST_UNCONFIRMED",
    })
  }
  fs.writeFileSync(f.controlPath, "{broken")
  await assert.rejects(assertNoPreviousHost(f.controlPath, f.projectId), {
    code: "PREVIOUS_HOST_UNCONFIRMED",
  })
  fs.writeFileSync(f.controlPath, "x".repeat(65537))
  await assert.rejects(assertNoPreviousHost(f.controlPath, f.projectId), {
    code: "PREVIOUS_HOST_UNCONFIRMED",
  })
  f.write(f.identity)
  fs.linkSync(f.controlPath, path.join(f.state, "aliased-control.json"))
  await assert.rejects(assertNoPreviousHost(f.controlPath, f.projectId), {
    code: "PREVIOUS_HOST_UNCONFIRMED",
  })
})

test("Windows skips an excluded legacy TCP port only after all independent negative checks", async t => {
  const f = fixture(t)
  const fake = fakeBindings()
  const lock = await acquireProjectLock(
    { ...f, platform: "win32" },
    { ...fake, portExcluded: async () => true, portListening: async () => false },
  )
  assert.equal(lock.kind, "named-pipe")
  assert.equal(lock.legacyPortExcluded, true)
  assert.equal(fake.servers[0].listening, true)
  await lock.close()
  assert.equal(fake.servers[0].listening, false)
  for (const checks of [
    {
      portExcluded: async () => false,
      portListening: async () => false,
      nonListeningConnections: async () => false,
    },
    { portExcluded: async () => true, portListening: async () => true },
    {
      portExcluded: async () => {
        throw error("NETSH_FAILED")
      },
      portListening: async () => false,
    },
    {
      portExcluded: async () => true,
      portListening: async () => {
        throw error("ETIMEDOUT")
      },
    },
  ]) {
    const denied = fakeBindings()
    await assert.rejects(acquireProjectLock({ ...f, platform: "win32" }, { ...denied, ...checks }))
    assert.equal(denied.servers[0].listening, false, "Failed admission releases its own pipe")
  }
})

test("a busy legacy port and an unknown prior host cannot use excluded-port fallback", async t => {
  const f = fixture(t)
  let excludedCalls = 0
  const busy = fakeBindings("EADDRINUSE")
  await assert.rejects(
    acquireProjectLock(
      { ...f, platform: "win32" },
      {
        ...busy,
        portExcluded: async () => {
          excludedCalls++
          return true
        },
        portListening: async () => false,
      },
    ),
    { code: "EADDRINUSE" },
  )
  assert.equal(excludedCalls, 0)
  assert.equal(busy.servers[0].listening, false)
  f.write(f.identity)
  const unknown = fakeBindings()
  await assert.rejects(
    acquireProjectLock(
      { ...f, platform: "win32" },
      {
        ...unknown,
        queryStatus: async () => {
          throw error("ECONNREFUSED")
        },
        processAlive: () => true,
        portExcluded: async () => true,
        portListening: async () => false,
      },
    ),
    { code: "PREVIOUS_HOST_UNCONFIRMED" },
  )
  assert.equal(unknown.servers[0].listening, false)
})

test("an explicit control port equal to an excluded legacy port is never silently changed", async t => {
  const f = fixture(t)
  const fake = fakeBindings()
  await assert.rejects(
    acquireProjectLock(
      { ...f, platform: "win32", legacyServer: net.createServer() },
      { ...fake, portExcluded: async () => true, portListening: async () => false },
    ),
    { code: "EACCES" },
  )
  assert.equal(fake.servers[0].listening, false)
})

test("Linux checks stale control before binding its old control/lock port", async t => {
  const f = fixture(t)
  f.write(f.identity)
  const sequence = []
  const server = {
    listening: true,
    close(callback) {
      this.listening = false
      callback()
    },
  }
  const lock = await acquireProjectLock(
    { ...f, platform: "linux" },
    {
      queryStatus: async () => {
        sequence.push("old-status")
        throw error("ECONNREFUSED")
      },
      processAlive: () => false,
      listen: async endpoint => {
        assert.equal(typeof endpoint, "number")
        sequence.push("bind-lock")
        return server
      },
    },
  )
  assert.deepEqual(sequence, ["old-status", "bind-lock"])
  await lock.close()
})

test(
  "actual project lock refuses a second owner and releases for a later owner",
  { skip: !["win32", "linux"].includes(process.platform) },
  async t => {
    const f = fixture(t)
    const first = await acquireProjectLock(f)
    try {
      await assert.rejects(acquireProjectLock(f), error =>
        ["EADDRINUSE", "EACCES"].includes(error.code),
      )
    } finally {
      await first.close()
    }
    const next = await acquireProjectLock(f)
    await next.close()
  },
)

test(
  "an existing Windows excluded TCP range uses the real named-pipe admission path",
  { skip: process.platform !== "win32", timeout: 10000 },
  async t => {
    const f = fixture(t)
    const output = execFileSync(
      path.join(process.env.SystemRoot || "C:\\Windows", "System32/netsh.exe"),
      ["interface", "ipv4", "show", "excludedportrange", "protocol=tcp"],
      { encoding: "utf8", windowsHide: true, timeout: 5000 },
    )
    const range = excludedPortRanges(output).find(([start, end]) => start <= 59999 && end >= 40000)
    if (!range) return t.skip("This Windows host has no excluded port in the legacy lock range")
    const port = Math.max(40000, range[0])
    const projectId = (port - 40000).toString(16).padStart(6, "0") + "0".repeat(10)
    const lock = await acquireProjectLock({ projectId, controlPath: f.controlPath })
    try {
      assert.equal(lock.kind, "named-pipe")
      assert.equal(lock.legacyPort, port)
      if (!lock.legacyPortExcluded)
        t.diagnostic(
          "Windows allowed loopback binding in the listed range; the legacy bridge was retained",
        )
    } finally {
      await lock.close()
    }
  },
)

test("only fully identified non-listening connection rows permit the outbound collision exception", async t => {
  const f = fixture(t)
  const rows = [
    { state: "Bound", owner: 1234, remote: "0.0.0.0", remotePort: 0 },
    { state: "Established", owner: 1234, remote: "192.0.2.1", remotePort: 443 },
  ]
  assert.equal(onlyNonListeningConnections(rows), true)
  for (const value of [
    [],
    [rows[0]],
    [rows[1]],
    [...rows, { state: "Listen", owner: 1234, remote: "0.0.0.0", remotePort: 0 }],
    [rows[0], { ...rows[1], owner: 5678 }],
    [rows[0], { ...rows[1], state: "Unknown" }],
    [rows[0], { ...rows[1], remotePort: 0 }],
    [rows[0], { ...rows[1], remote: "not-an-address" }],
  ])
    assert.equal(onlyNonListeningConnections(value), false)
  const fake = fakeBindings()
  const lock = await acquireProjectLock(
    { ...f, platform: "win32" },
    {
      ...fake,
      portExcluded: async () => false,
      portListening: async () => false,
      nonListeningConnections: async () => onlyNonListeningConnections(rows),
    },
  )
  assert.equal(lock.legacyBridgeUnavailable, true)
  assert.equal(lock.legacyBridgeReason, "non-listening-connections")
  assert.equal(lock.legacyPortExcluded, false)
  await lock.close()
  for (const check of [
    async () => false,
    async () => {
      throw error("TCP_TABLE_UNAVAILABLE")
    },
  ]) {
    const denied = fakeBindings()
    await assert.rejects(
      acquireProjectLock(
        { ...f, platform: "win32" },
        {
          ...denied,
          portExcluded: async () => false,
          portListening: async () => false,
          nonListeningConnections: check,
        },
      ),
    )
    assert.equal(denied.servers[0].listening, false)
  }
})

async function control(file, command) {
  const identity = JSON.parse(fs.readFileSync(file))
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: identity.port })
    let input = ""
    socket.setTimeout(3000, () => socket.destroy(new Error("Test control timeout")))
    socket.on("error", reject)
    socket.on("connect", () =>
      socket.write(JSON.stringify({ token: identity.token, command }) + "\n"),
    )
    socket.on("data", bytes => {
      input += bytes
      if (input.includes("\n")) {
        socket.destroy()
        resolve(JSON.parse(input.split("\n")[0]))
      }
    })
  })
}

async function until(predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await pause(30)
  }
  throw new Error(message)
}

test(
  "real supervisors keep one project owner across different control settings and OS-selected ports",
  { skip: !["win32", "linux"].includes(process.platform), timeout: 45000 },
  async t => {
    const f = fixture(t)
    fs.writeFileSync(path.join(f.root, "package.json"), '{"type":"module"}')
    fs.writeFileSync(
      path.join(f.root, "app.js"),
      `import{EventEmitter}from"node:events";globalThis.Bot=new EventEmitter();Bot.em=()=>{};Bot.prepareEvent=()=>{};Bot.exitEvent=async()=>{};Bot.redisExit=async()=>{};setTimeout(()=>Bot.emit("online"),100);setInterval(()=>{},1000);`,
    )
    const settingsFile = path.join(f.state, "settings.json")
    fs.writeFileSync(settingsFile, JSON.stringify({ startupTimeout: 5000, shutdownTimeout: 500 }))
    const children = []
    let output = ""
    const start = () => {
      const env = { ...process.env, NODE_OPTIONS: "" }
      for (const key of ["pm_id", "PM2_HOME", "NODE_APP_INSTANCE", "YUNZAI_GUARD_RUNTIME_MANIFEST"])
        delete env[key]
      const child = spawn(process.execPath, [path.join(repository, "dist/launcher.js")], {
        cwd: f.root,
        env,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      })
      child.stderr.on("data", bytes => {
        output += bytes
      })
      children.push(child)
      return child
    }
    try {
      const first = start()
      const online = await until(async () => {
        if (first.exitCode !== null) throw new Error("Host exited before online: " + output)
        if (!fs.existsSync(f.controlPath)) return false
        try {
          const status = await control(f.controlPath, "status")
          return status.phase === "online" ? status : false
        } catch {
          return false
        }
      }, "First host did not become online")
      const credential = JSON.parse(fs.readFileSync(f.controlPath))
      assert.ok(credential.port > 0)
      assert.notEqual(credential.port, legacyProjectPort(f.projectId))
      assert.equal(online.lockType, process.platform === "win32" ? "named-pipe" : "tcp")
      const unchanged = fs.readFileSync(f.controlPath)
      const differentPort = credential.port === 12345 ? 12346 : 12345
      fs.writeFileSync(
        settingsFile,
        JSON.stringify({ controlPort: differentPort, startupTimeout: 5000, shutdownTimeout: 500 }),
      )
      const second = start()
      await until(() => second.exitCode !== null, "Duplicate host did not refuse ownership")
      assert.equal(second.exitCode, 2)
      assert.deepEqual(fs.readFileSync(f.controlPath), unchanged)
      assert.equal((await control(f.controlPath, "status")).hostPid, first.pid)
      await control(f.controlPath, "stop")
      await until(() => first.exitCode !== null, "First host did not shut down")
      assert.equal(first.exitCode, 0)
    } finally {
      if (fs.existsSync(f.controlPath)) await control(f.controlPath, "stop").catch(() => {})
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          child.kill()
          await until(
            () => child.exitCode !== null || child.signalCode !== null,
            "Test-owned child did not stop",
          )
        }
    }
  },
)
