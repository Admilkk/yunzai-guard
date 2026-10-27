import assert from "node:assert/strict"
import { readAuditRecords } from "./audit-reader.mjs"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

const testsRoot = path.dirname(fileURLToPath(import.meta.url))
const repository = path.dirname(testsRoot)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function until(predicate, description, timeout = 60000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await pause(40)
  }
  throw new Error(description)
}

export async function fixturePorts(projectLockPort) {
  const servers = [],
    ports = []
  try {
    // 选择端口时同时保留绑定，避免连续绑定后关闭取得同一端口；排除的锁端口也保持占用。
    while (ports.length < 2) {
      const server = net.createServer()
      servers.push(server)
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const port = server.address().port
      if (port !== projectLockPort) ports.push(port)
    }
    return { serverPort: ports[0], controlPort: ports[1] }
  } finally {
    await Promise.all(
      servers
        .filter(server => server.listening)
        .map(
          server =>
            new Promise((resolve, reject) =>
              server.close(error => (error ? reject(error) : resolve())),
            ),
        ),
    )
  }
}

/** 可注入 /proc 读取器；只有确认缺失或有效僵尸记录才视为进程不存在。 */
export function readLinuxProcessRow(pid, readStat = file => fs.readFileSync(file, "utf8")) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "A positive process PID is required")
  const unknown = error => ({ pid, parent: null, start: null, error })
  let raw
  try {
    raw = readStat(`/proc/${pid}/stat`)
  } catch (error) {
    let code
    try {
      code = error?.code
    } catch {}
    if (code === "ENOENT" || code === "ESRCH") return undefined
    return unknown(
      typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "STAT_READ_FAILED",
    )
  }
  if (typeof raw !== "string") return unknown("INVALID_PROC_STAT")
  const separator = raw.lastIndexOf(") "),
    prefix = raw.match(/^(\d+) \(/),
    fields =
      separator >= 0
        ? raw
            .slice(separator + 2)
            .trim()
            .split(/\s+/)
        : []
  if (
    !prefix ||
    BigInt(prefix[1]) !== BigInt(pid) ||
    separator < prefix[0].length ||
    fields.length < 20 ||
    !/^[RSDZTtXxKWPI]$/.test(fields[0]) ||
    !/^\d+$/.test(fields[1]) ||
    !Number.isSafeInteger(Number(fields[1])) ||
    !/^\d+$/.test(fields[19]) ||
    BigInt(fields[19]) <= 0n
  )
    return unknown("INVALID_PROC_STAT")
  if (["Z", "X", "x"].includes(fields[0])) return undefined
  return { pid, parent: Number(fields[1]), start: fields[19] }
}

export function readWindowsProcessRows(execute = execFileSync) {
  const command =
    "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;@(Get-CimInstance Win32_Process | ForEach-Object { @{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; start = if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssfff')}else{$null} } }) | ConvertTo-Json -Compress"
  const output = execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
  }).trim()
  assert.ok(output, "Windows process census returned no metadata")
  const values = JSON.parse(output),
    rows = Array.isArray(values) ? values : [values]
  assert.ok(
    rows.every(row => row && Number.isSafeInteger(row.pid) && row.pid >= 0),
    "Windows process census returned invalid metadata",
  )
  return rows
}

function processes() {
  if (process.platform === "win32") return readWindowsProcessRows()
  assert.equal(process.platform, "linux", "Environment fixtures support Windows and Linux only")
  const rows = []
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid /proc process PID")
    const row = readLinuxProcessRow(pid)
    if (row) rows.push(row)
  }
  return rows
}

export function processBirth(row) {
  return typeof row?.start === "string" && /^\d+$/.test(row.start) && BigInt(row.start) > 0n
    ? BigInt(row.start)
    : null
}

// 身份检查保留创建时间未知的记录，避免按出生时间裁剪后误判 PID 不存在。
export function processIdentity(pid, rows = processes()) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "A positive process PID is required")
  assert.ok(Array.isArray(rows), "A process metadata table is required")
  assert.ok(
    rows.every(row => row && Number.isSafeInteger(row.pid) && row.pid >= 0),
    "Invalid process metadata row",
  )
  const matches = rows.filter(row => row.pid === pid)
  assert.ok(matches.length <= 1, "Conflicting process identity rows")
  const row = matches[0]
  if (row && (!Number.isSafeInteger(row.parent) || row.parent < 0 || processBirth(row) === null))
    return {
      pid,
      parent: null,
      start: null,
      error:
        typeof row.error === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(row.error)
          ? row.error
          : "INVALID_PROCESS_METADATA",
    }
  return row
}

// 历史父 PID 可能已被无关进程复用，调用方须独立绑定创建者或 God 的身份。
export function inspectBirthBoundScope(rows, rootPid) {
  const unresolved = [],
    result = { rows: [], unresolved }
  if (!Array.isArray(rows) || !Number.isSafeInteger(rootPid) || rootPid <= 0) {
    unresolved.push({ pid: rootPid, reason: "invalid-scope-request" })
    return result
  }
  const byPid = new Map(),
    duplicates = new Set()
  for (const row of rows) {
    if (!row || !Number.isSafeInteger(row.pid) || row.pid < 0) {
      unresolved.push({ pid: rootPid, reason: "invalid-process-table-row" })
      return result
    }
    if (row.pid === 0) continue
    if (byPid.has(row.pid)) duplicates.add(row.pid)
    byPid.set(row.pid, row)
  }
  const root = byPid.get(rootPid)
  if (
    !root ||
    duplicates.has(rootPid) ||
    processBirth(root) === null ||
    !Number.isSafeInteger(root.parent) ||
    root.parent < 0
  ) {
    unresolved.push({
      pid: rootPid,
      reason: !root ? "root-missing" : duplicates.has(rootPid) ? "root-conflict" : "root-unknown",
    })
    return result
  }
  const accepted = new Set([rootPid]),
    pending = [root]
  while (pending.length) {
    const parent = pending.shift(),
      parentBirth = processBirth(parent)
    for (const child of rows) {
      if (child?.parent !== parent.pid || accepted.has(child.pid)) continue
      if (duplicates.has(child.pid)) {
        if (!unresolved.some(value => value.pid === child.pid))
          unresolved.push({ pid: child.pid, reason: "related-child-conflict" })
        continue
      }
      const childBirth = processBirth(child)
      if (childBirth === null) {
        unresolved.push({ pid: child.pid, reason: "related-child-unknown" })
        continue
      }
      if (childBirth < parentBirth) continue
      accepted.add(child.pid)
      pending.push(child)
    }
  }
  if (accepted.has(root.parent)) {
    unresolved.push({ pid: rootPid, reason: "scope-parent-cycle" })
    return result
  }
  result.rows = rows.filter(row => accepted.has(row?.pid))
  return result
}

export function selectBirthBoundScope(rows, rootPid) {
  return inspectBirthBoundScope(rows, rootPid).rows
}

// 仅表示当前时刻出生时间一致的进程树，不证明归属或完整创建记录。
export function snapshot(rootPid, rows = processes()) {
  assert.ok(Number.isSafeInteger(rootPid) && rootPid > 0, "A positive root PID is required")
  const result = inspectBirthBoundScope(rows, rootPid)
  if (result.unresolved.length) {
    const error = new Error(
      "Fixture scope census is incomplete: " + JSON.stringify(result.unresolved),
    )
    error.code = "GUARD_FIXTURE_SCOPE_UNKNOWN"
    error.scopeDiagnostics = result.unresolved
    throw error
  }
  return result.rows
}

/** 尝试独立验证的正常停止前，先保留观测错误。 */
export async function stopAfterCensus({ prove, census, stop, onCensusError = () => {} }) {
  await prove()
  let censusError
  try {
    await census()
  } catch (error) {
    censusError = error.stack || String(error)
    onCensusError(censusError)
  }
  try {
    await prove()
    await stop()
  } catch (error) {
    if (!censusError) throw error
    const combined = new Error(
      "Normal stop/proof failed after an incomplete census:\n" + (error.stack || String(error)),
      { cause: error },
    )
    combined.censusError = censusError
    combined.controlError = error.stack || String(error)
    throw combined
  }
  return { stopped: true, censusError }
}

export async function waitScopeGone(identities, { timeout = 30000 } = {}) {
  assert.ok(Array.isArray(identities), "A scope identity snapshot is required")
  assert.ok(
    identities.every(row => processBirth(row) !== null),
    "Known original births are required",
  )
  await until(
    () => {
      const current = processes()
      return identities.every(previous => {
        const actual = processIdentity(previous.pid, current)
        return !actual || (processBirth(actual) !== null && actual.start !== previous.start)
      })
    },
    "An observed fixture scope still contains a live process",
    timeout,
  )
}

// 生命周期夹具只替换外部 Redis 包，不修改核心、生产 Redis 或系统回环规则。
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

const lifecycleProbe = `
import fs from "node:fs"
import path from "node:path"
export class GuardEnvironmentProbe extends plugin {
  constructor() { super({ name: "Guard environment lifecycle fixture", rule: [] }) }
  init() {
    fs.appendFileSync(path.resolve("data/environment-lifecycle.jsonl"), JSON.stringify({
      event: "started", pid: process.pid, time: Date.now()
    }) + "\\n")
  }
}
`

function readJsonLines(file) {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .slice(0, -1)
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

function requestControl(stateDir, command) {
  const credential = JSON.parse(fs.readFileSync(path.join(stateDir, "control.json"), "utf8"))
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: credential.port })
    let input = ""
    let complete = false
    socket.setTimeout(5000, () => socket.destroy(new Error("Fixture control timeout")))
    socket.on("error", reject)
    socket.on("connect", () =>
      socket.write(JSON.stringify({ token: credential.token, command }) + "\n"),
    )
    socket.on("data", chunk => {
      input += chunk
      if (complete || !input.includes("\n")) return
      complete = true
      socket.end()
      try {
        resolve(JSON.parse(input.split("\n")[0]))
      } catch (error) {
        reject(error)
      }
    })
    socket.on("end", () => {
      if (!complete) reject(new Error("Fixture control closed without a complete response"))
    })
  })
}

/** 创建隔离的真实核心项目并保存测试产物；准备阶段不启动宿主进程。 */
export async function createEnvironmentFixture({
  mode = "os-sandbox",
  label = "environment",
  settings = {},
  probe = true,
  guardSource = process.env.GUARD_TEST_GUARD_SOURCE ?? repository,
} = {}) {
  assert.ok(["managed", "os-sandbox"].includes(mode), "Unknown fixture isolation mode")
  assert.ok(["linux", "win32"].includes(process.platform), "Unsupported fixture platform")
  for (const item of ["source/app.js", "bundle/node_modules", "core-manifest.json"])
    assert.ok(
      fs.existsSync(path.join(testsRoot, item)),
      "Run tests/prepare.mjs before environment tests",
    )
  const guardDirectory = fs.realpathSync.native(guardSource)
  for (const item of ["index.js", "dist/launcher.js", "native/windows/GuardSandbox.cs"])
    assert.ok(
      fs.existsSync(path.join(guardDirectory, item)),
      "Build Guard before environment tests",
    )
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "environment"
  const runRoot = path.join(
    testsRoot,
    "runs",
    `${safeLabel}-${process.platform}-${Date.now()}-${randomUUID().slice(0, 8)}`,
  )
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
  const pluginDir = path.join(root, "plugins/yunzai-guard")
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.copyFileSync(path.join(guardDirectory, "index.js"), path.join(pluginDir, "index.js"))
  for (const directory of ["dist", "native"])
    fs.cpSync(path.join(guardDirectory, directory), path.join(pluginDir, directory), {
      recursive: true,
      dereference: true,
    })
  if (probe) {
    const probeDir = path.join(root, "plugins/guard-environment-probe")
    fs.mkdirSync(probeDir, { recursive: true })
    fs.writeFileSync(path.join(probeDir, "index.js"), lifecycleProbe)
  }
  for (const directory of ["renderers", "temp", "logs", "config/config", "data/yunzai-guard"])
    fs.mkdirSync(path.join(root, directory), { recursive: true })
  const canonicalRoot = fs.realpathSync.native(root)
  const projectIdentity = process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot
  const projectHash = createHash("sha256").update(projectIdentity).digest("hex")
  const projectLockPort = 40000 + (parseInt(projectHash.slice(0, 6), 16) % 20000)
  const { serverPort, controlPort } = await fixturePorts(projectLockPort)
  fs.writeFileSync(
    path.join(root, "config/config/server.yaml"),
    `port: ${serverPort}\nurl: http://127.0.0.1:${serverPort}\nauth: {}\n`,
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
  const stateDir = path.join(root, "data/yunzai-guard")
  const fixtureSettings = {
    schemaVersion: 1,
    controlPort,
    startupTimeout: 45000,
    handshakeTimeout: 15000,
    shutdownTimeout: 1500,
    recovery: { maxRestarts: 2, windowMs: 60000, baseDelayMs: 50, maxDelayMs: 100 },
    audit: { maxEventsPerSecond: 1000 },
    ...settings,
    isolationMode: mode,
    sandbox: { network: "none", ...settings.sandbox },
  }
  assert.notEqual(fixtureSettings.controlPort, serverPort, "Fixture control/core ports must differ")
  assert.notEqual(
    fixtureSettings.controlPort,
    projectLockPort,
    "Fixture control/lock ports must differ",
  )
  fs.writeFileSync(
    path.join(stateDir, "settings.json"),
    JSON.stringify(fixtureSettings, null, 2) + "\n",
  )
  const expectedHashes = JSON.parse(
    fs.readFileSync(path.join(testsRoot, "core-manifest.json"), "utf8"),
  )
  assert.equal(Object.keys(expectedHashes).length, 47)
  fs.copyFileSync(
    path.join(testsRoot, "core-manifest.json"),
    path.join(runRoot, "core-manifest.json"),
  )
  const observed = new Map()
  const control = command => requestControl(stateDir, command)
  const status = () => control("status")
  async function waitForStatus(
    predicate,
    { timeout = 60000, description = "Fixture did not reach the requested status" } = {},
  ) {
    assert.equal(typeof predicate, "function", "A status predicate is required")
    return until(
      async () => {
        let current
        try {
          current = await status()
        } catch (error) {
          if (["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes(error.code)) return false
          throw error
        }
        return (await predicate(current)) ? current : false
      },
      description,
      timeout,
    )
  }
  async function waitOnline(minimumGeneration = 1, options = {}) {
    const current = await waitForStatus(
      current =>
        current.phase === "tripped" ||
        (current.phase === "online" && current.generation >= minimumGeneration),
      { description: "Fixture did not become online", ...options },
    )
    assert.notEqual(current.phase, "tripped", `Fixture startup tripped: ${current.trippedReason}`)
    for (const identity of snapshot(current.hostPid))
      observed.set(`${identity.pid}:${identity.start}`, identity)
    return current
  }
  const events = () => readAuditRecords(stateDir)
  const lifecycle = () => readJsonLines(path.join(root, "data/environment-lifecycle.jsonl"))
  const cliPath = path.join(pluginDir, "dist/cli.js")
  const cli = command =>
    JSON.parse(
      execFileSync(process.execPath, [cliPath, command], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
      }),
    )
  function verifyCoreHashes() {
    for (const [file, expected] of Object.entries(expectedHashes))
      assert.equal(
        createHash("sha256")
          .update(fs.readFileSync(path.join(root, file)))
          .digest("hex"),
        expected,
        `Core changed: ${file}`,
      )
    return { coreFileHashCount: 47, coreFilesUnchanged: true }
  }
  async function finish({ stop = true, timeout = 30000 } = {}) {
    const errors = []
    if (stop) {
      try {
        const controlFile = path.join(stateDir, "control.json"),
          credential = fs.readFileSync(controlFile, "utf8")
        const current = await status()
        await stopAfterCensus({
          prove: () =>
            assert.ok(
              fs.readFileSync(controlFile, "utf8") === credential,
              "Private control credentials changed",
            ),
          census: () => {
            for (const identity of snapshot(current.hostPid))
              observed.set(`${identity.pid}:${identity.start}`, identity)
          },
          onCensusError: error => errors.push(new Error(error)),
          stop: () => control("stop"),
        })
      } catch (error) {
        if (!["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes(error.code)) errors.push(error)
      }
    }
    try {
      await waitScopeGone([...observed.values()], { timeout })
    } catch (error) {
      errors.push(error)
    }
    let result
    try {
      result = verifyCoreHashes()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        "Fixture finish retained observation/control errors:\n" +
          errors.map(error => error.stack || String(error)).join("\n"),
      )
    return result
  }
  verifyCoreHashes()
  return {
    root,
    runRoot,
    pluginDir,
    stateDir,
    launcher: path.join(pluginDir, "dist/launcher.js"),
    cliPath,
    expectedHashes,
    settings: fixtureSettings,
    redisFixture:
      "in-memory EventEmitter dependency stub; no production Redis or loopback exemption",
    dependencyLayout:
      "offline bundle copied inside project; four local-module links remain inside it",
    control,
    status,
    waitForStatus,
    waitOnline,
    events,
    lifecycle,
    cli,
    verifyCoreHashes,
    finish,
  }
}
