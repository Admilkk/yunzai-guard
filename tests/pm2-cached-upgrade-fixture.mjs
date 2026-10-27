import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { execFile, execFileSync, spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { performance } from "node:perf_hooks"
import {
  createEnvironmentFixture,
  processBirth,
  processIdentity,
  readLinuxProcessRow,
  stopAfterCensus,
  snapshot,
  until,
  waitScopeGone,
} from "./environment-fixture.mjs"
import {
  ensureCachedUpgradePrerequisites,
  prepareLinuxReclaimRequest,
  executeLinuxReclaim,
} from "./cached-upgrade-prerequisites.mjs"
const execute = promisify(execFile)
const tests = path.dirname(fileURLToPath(import.meta.url))
const historicalHash = "de88fb7b656098a69787556d1153be84e5fdeedb6fc4632a864b268f843b684e"
const channel = "guard-cached-upgrade-fixture-v1"
const sha = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
const stable = value =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map(k => [k, stable(value[k])]),
        )
      : value
const digest = value =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex")
const read = file => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "")
export const powershellUtf8 =
  "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;"
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n")
const canonical = file => {
  const value = fs.realpathSync.native(file)
  return process.platform === "win32" ? value.toLowerCase() : value
}
function identity(pid) {
  return processIdentity(pid)
}
function physicalDetails(previous, powershellPath) {
  if (!previous || identity(previous.pid)?.start !== previous.start) return undefined
  let details
  if (process.platform === "win32") {
    const script =
      powershellUtf8 +
      `$p=[Diagnostics.Process]::GetProcessById(${previous.pid});try{$null=$p.Handle;$started=$p.StartTime.ToUniversalTime();if($started.ToString('yyyyMMddHHmmssfff') -ne '${previous.start}'){throw 'Identity changed'};$c=Get-CimInstance Win32_Process -Filter 'ProcessId = ${previous.pid}';@{pid=$p.Id;start=$started.ToString('yyyyMMddHHmmssfff');ticks=$started.Ticks.ToString();parent=[int]$c.ParentProcessId;executable=$c.ExecutablePath}|ConvertTo-Json -Compress}finally{$p.Dispose()}`
    details = JSON.parse(
      execFileSync(powershellPath, ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
      }),
    )
  } else {
    const base = `/proc/${previous.pid}`
    details = {
      ...previous,
      executable: fs.readlinkSync(`${base}/exe`),
      pidNamespace: fs.readlinkSync(`${base}/ns/pid`),
      nspid: fs.readFileSync(`${base}/status`, "utf8").match(/^NSpid:\s*(.+)$/m)?.[1],
    }
  }
  assert.equal(
    identity(previous.pid)?.start,
    previous.start,
    "Identity changed while reading physical details",
  )
  return details
}
// 仅在失败时回收已观测身份；Windows 持有进程对象核对创建时间，Linux 使用固定的测试 pidfd helper。
async function reclaimOwned(identities, admitted, prerequisites) {
  if (!identities.length) return []
  const encoded = Buffer.from(JSON.stringify(identities)).toString("base64")
  if (process.platform === "win32") {
    const script =
      powershellUtf8 +
      `$rows=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json;$out=@();foreach($row in $rows){$p=$null;try{$p=[Diagnostics.Process]::GetProcessById([int]$row.pid);$null=$p.Handle;$created=$p.StartTime.ToUniversalTime();if($created.ToString('yyyyMMddHHmmssfff') -eq $row.start -and (!$row.ticks -or $created.Ticks.ToString() -eq $row.ticks)){$p.Kill();if(!$p.WaitForExit(5000)){throw 'Own process did not exit'};$out+=@{pid=$row.pid;start=$row.start;result='terminated-exact-held-handle'}}else{$out+=@{pid=$row.pid;start=$row.start;result='identity-no-longer-matches'}}}catch{$out+=@{pid=$row.pid;start=$row.start;error=$_.Exception.Message}}finally{if($p){$p.Dispose()}}};ConvertTo-Json -InputObject $out -Compress`
    const result = await execute(
      prerequisites.powershell.resolved,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 15000 },
    )
    return JSON.parse(result.stdout)
  }
  const deadline = performance.now() + 15000
  const prepared = prepareLinuxReclaimRequest(identities, admitted, {
    readBirth: readLinuxProcessRow,
    readNamespace(pid) {
      const stat = fs.statSync(`/proc/${pid}/ns/pid`, { bigint: true })
      return `${stat.dev}:${stat.ino}`
    },
  })
  if (!prepared.request.records.length)
    return { ...prepared, nativeRun: null, scopeObservationComplete: false }
  const nativeRun = await executeLinuxReclaim(prerequisites.helper, prepared.request, undefined, {
    deadline,
  })
  return { ...prepared, nativeRun, scopeObservationComplete: false }
}
function regularTree(root) {
  const files = {}
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name),
        stat = fs.lstatSync(file),
        key = path.relative(root, file).replaceAll(path.sep, "/")
      if (stat.isDirectory()) visit(file)
      else if (stat.isSymbolicLink()) files[key] = { link: fs.readlinkSync(file) }
      else {
        assert.ok(stat.isFile())
        files[key] = sha(file)
      }
    }
  }
  visit(root)
  return files
}
function manifest(root, file, expected) {
  assert.match(expected, /^[a-f0-9]{64}$/)
  assert.equal(sha(file), expected)
  const files = JSON.parse(fs.readFileSync(file))
  for (const [name, value] of Object.entries(files)) {
    const relative = path.relative(root, path.resolve(root, name))
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative))
    assert.ok(fs.lstatSync(path.join(root, name)).isFile())
    assert.equal(sha(path.join(root, name)), value, name)
  }
  return files
}
const sameBirth = (expected, actual) =>
  Boolean(
    expected &&
    actual &&
    expected.pid === actual.pid &&
    expected.start === actual.start &&
    expected.parent === actual.parent,
  )
function verifyScopeMetadata({
  rows,
  expectedRoot,
  expectedDaemon,
  rootBefore,
  rootAfter,
  daemonBefore,
  daemonAfter,
  workerPid,
}) {
  const daemonBirth = processBirth(expectedDaemon),
    rootBirth = processBirth(expectedRoot)
  for (const row of [expectedDaemon, expectedRoot])
    assert.ok(
      Number.isSafeInteger(row?.pid) &&
        row.pid > 1 &&
        Number.isSafeInteger(row.parent) &&
        row.parent >= 0,
      "Unknown root or daemon metadata",
    )
  assert.ok(
    daemonBirth !== null && rootBirth !== null && rootBirth >= daemonBirth,
    "Unknown or older-than-daemon root birth",
  )
  assert.ok(
    sameBirth(expectedDaemon, daemonBefore) && sameBirth(expectedDaemon, daemonAfter),
    "Held daemon birth changed",
  )
  assert.ok(
    sameBirth(expectedRoot, rootBefore) && sameBirth(expectedRoot, rootAfter),
    "Expected root birth changed",
  )
  const map = new Map()
  for (const row of rows) {
    assert.ok(
      Number.isSafeInteger(row.pid) &&
        row.pid > 1 &&
        Number.isSafeInteger(row.parent) &&
        row.parent >= 0 &&
        processBirth(row) !== null,
    )
    assert.equal(map.has(row.pid), false, "Duplicate candidate PID")
    map.set(row.pid, row)
  }
  assert.ok(
    sameBirth(expectedRoot, map.get(expectedRoot.pid)),
    "Candidate tree does not contain the bound root",
  )
  if (expectedRoot.pid !== expectedDaemon.pid)
    assert.equal(
      expectedRoot.parent,
      expectedDaemon.pid,
      "Application root is outside the held daemon",
    )
  for (const row of rows) {
    let cursor = row,
      seen = new Set()
    while (cursor.pid !== expectedRoot.pid) {
      assert.equal(seen.has(cursor.pid), false, "Candidate parent cycle")
      seen.add(cursor.pid)
      const parent = map.get(cursor.parent)
      assert.ok(parent, "Unrelated candidate is outside the bound root tree")
      assert.ok(
        processBirth(parent) !== null && processBirth(cursor) >= processBirth(parent),
        "Child birth precedes its current numeric parent",
      )
      cursor = parent
    }
  }
  if (workerPid !== undefined)
    assert.equal(
      map.get(workerPid)?.parent,
      expectedRoot.pid,
      "Worker must be the bound host's direct child",
    )
  return map
}
/** 调用原生详情回调前，必须完成元数据验证。 */
export function observeBoundScope(metadata, observe) {
  verifyScopeMetadata(metadata)
  return metadata.rows.map(observe)
}
/** 完整确认独立绑定的作用域后再登记，否则保留原回收记录。 */
export function admitOwnedScope(ledger, metadata) {
  const { rows, physical, expectedRoot } = metadata
  verifyScopeMetadata(metadata)
  for (const row of rows) {
    const details = physical.find(item => item.pid === row.pid)
    assert.ok(
      sameBirth(row, details),
      "Native birth or parent changed during candidate observation",
    )
  }
  const physicalRoot = physical.find(item => item.pid === expectedRoot.pid)
  if (expectedRoot.ticks)
    assert.equal(physicalRoot.ticks, expectedRoot.ticks, "Root precise creation ticks changed")
  if (expectedRoot.pidNamespace)
    assert.equal(physicalRoot.pidNamespace, expectedRoot.pidNamespace, "Root PID namespace changed")
  for (const row of rows) ledger.set(`${row.pid}:${row.start}`, { ...row })
  return rows
}
export function classifyPrivateDaemon(original, { present, pid, current, error }) {
  if (error) return { status: "unknown", error }
  if (!present) return { status: "none-live", pidFile: "absent" }
  if (!Number.isSafeInteger(pid) || pid <= 1)
    return { status: "unknown", error: "Invalid private pid file" }
  if (!current) return { status: "none-live", pidFile: "stale", pid }
  if (current.pid !== pid)
    return { status: "unknown", error: "Private pid identity lookup mismatch" }
  if (processBirth(current) === null)
    return {
      status: "unknown",
      error: "Private daemon creation metadata is unknown",
      identity: current,
    }
  return {
    status: sameBirth(original, current) ? "original-live" : "replacement-live",
    identity: current,
  }
}
/** 仅为已绑定身份记录只读缺失回执，不授予进程归属。 */
export function observeOriginalExits(identities, lookup) {
  return identities.map(expected => {
    try {
      assert.ok(processBirth(expected) !== null, "Bound original creation metadata is unknown")
      const current = lookup(expected.pid)
      assert.ok(!current || current.pid === expected.pid, "Exit lookup returned another PID")
      const known = !current || processBirth(current) !== null
      const originalExited = known && (!current || current.start !== expected.start)
      return {
        expected,
        current: current || null,
        originalExited,
        status: !known
          ? "unknown"
          : originalExited
            ? "original-identity-absent"
            : "original-still-live",
      }
    } catch (error) {
      return {
        expected,
        originalExited: false,
        status: "unknown",
        error: error.stack || String(error),
      }
    }
  })
}
/** 已独立确认原守护进程身份时，停止前不强制重新普查。 */
export async function stopWithIndependentCensus({ prove, census, stop, onCensusError }) {
  const requireProof = value => {
    assert.ok(
      value &&
        processBirth(value.original) !== null &&
        sameBirth(value.original, value.current) &&
        value.privateState?.status === "original-live" &&
        sameBirth(value.original, value.privateState.identity),
      "Original private daemon stop is not independently proven",
    )
  }
  return stopAfterCensus({
    prove: async () => requireProof(await prove()),
    census,
    stop,
    onCensusError,
  })
}
export function privateAppDeclaration(app) {
  return (
    "module.exports=" +
    JSON.stringify({ apps: [{ ...app, filter_env: ["NODE_OPTIONS", "PM2_NODE_OPTIONS"] }] }) +
    "\n"
  )
}
export function summarizeDeclaredLogs({ daemonText, errorTexts, targetHosts, peerHosts }) {
  assert.equal(
    targetHosts.length,
    new Set(targetHosts).size,
    "Repeated target host PID makes log correlation ambiguous",
  )
  assert.equal(
    peerHosts.length,
    new Set(peerHosts).size,
    "Repeated peer host PID makes log correlation ambiguous",
  )
  assert.equal(
    targetHosts.some(pid => peerHosts.includes(pid)),
    false,
    "Peer and target host PID overlap makes log correlation ambiguous",
  )
  const hashText = text => createHash("sha256").update(text).digest("hex")
  const events = daemonText.split(/\r?\n/).flatMap(line => {
    const tag = "[Yunzai Guard PM2] ",
      index = line.indexOf(tag)
    if (index < 0) return []
    try {
      const value = JSON.parse(line.slice(index + tag.length))
      return value && typeof value === "object" ? [value] : []
    } catch {
      return []
    }
  })
  const targetLogGateReceipts = events.filter(
    event => /^pm2-log-/.test(event.event) && targetHosts.includes(event.pid),
  )
  const oldPeerLogGateReceipts = events.filter(
    event => /^pm2-log-/.test(event.event) && peerHosts.includes(event.pid),
  )
  const counts = Object.fromEntries(
    targetHosts.map(pid => [pid, targetLogGateReceipts.filter(event => event.pid === pid).length]),
  )
  const rawDaemonStreamErrors = daemonText
    .split(/\r?\n/)
    .filter(line => line.includes("ERR_STREAM_DESTROYED"))
  return {
    declaredLogScanScope:
      "Complete daemon text for ERR_STREAM_DESTROYED plus complete old/new app stderr byte emptiness; not a claim about every daemon error or business log",
    logFiles: {
      daemon: { bytes: Buffer.byteLength(daemonText), sha256: hashText(daemonText) },
      errors: errorTexts.map(value => ({
        name: value.name,
        bytes: Buffer.byteLength(value.text),
        sha256: hashText(value.text),
        stderrTail: value.text.slice(-16000),
      })),
    },
    declaredLogChecksClear:
      rawDaemonStreamErrors.length === 0 && errorTexts.every(value => value.text.length === 0),
    targetLogGateReceipts,
    oldPeerLogGateReceipts,
    rawDaemonStreamErrors,
    targetLogGateCoverage: {
      expectedStoppedControlledHosts: targetHosts.length,
      actualReceipts: targetLogGateReceipts.length,
      receiptsPerHost: counts,
      exactlyOnePerHost:
        targetHosts.length === 21 &&
        targetLogGateReceipts.length === 21 &&
        Object.values(counts).every(value => value === 1),
      drained: targetLogGateReceipts.filter(event => event.event === "pm2-log-drained").length,
      explicitNotDrained: targetLogGateReceipts.filter(
        event => event.event === "pm2-log-not-drained",
      ).length,
    },
  }
}
export function assertUpgradeReceipt(value, { afterHot = false } = {}) {
  for (const key of [
    "stableNamespaceStillOld",
    "stableCapabilityAbsent",
    "oldPeerNamespaceStillSame",
    "freshNamespaceActuallyLoaded",
    "freshNamespaceDiffers",
    "legacyRegistrySame",
    "legacyMapSame",
    "legacyPeerApplicationSame",
    "targetAbsentFromLegacy",
    "freshTargetMatchesActive",
    "forkLineageRetained",
    "compatibilityLineageRetained",
    "legacyMethodSlotsMatchCurrent",
    "restartMethodUnchanged",
  ])
    assert.equal(value[key], true, key)
  assert.deepEqual(value.legacyIds, [0])
  assert.deepEqual(value.freshIds, [2])
  assert.deepEqual(value.freshCapabilities, {
    agentProtocol: 2,
    bootstrapExitBarrier: 1,
    cachedRegistryUpgrade: 1,
  })
  assert.equal(value.oldHotRegisterPerformed, afterHot)
  assert.equal(value.activePendingPreservationClaimed, false)
}
function allowlistedEnvironment(home) {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "XDG_RUNTIME_DIR",
    "SystemRoot",
    "WINDIR",
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
    "USERNAME",
    "USERDOMAIN",
    "ComSpec",
    "HOMEDRIVE",
    "HOMEPATH",
    "ProgramData",
    "ALLUSERSPROFILE",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "CommonProgramFiles",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
  ]
  return {
    ...Object.fromEntries(
      allowed.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]),
    ),
    PM2_HOME: home,
    PM2_NO_INTERACTION: "true",
    PM2_DISCRETE_MODE: "true",
    NO_COLOR: "1",
  }
}
async function probeInspector(url, expectedPid) {
  const parsed = new URL(url)
  assert.equal(parsed.protocol, "ws:")
  assert.equal(parsed.hostname, "127.0.0.1")
  return new Promise((resolve, reject) => {
    let received = false,
      failure
    const socket = new WebSocket(url),
      timer = setTimeout(() => {
        socket.close()
        reject(new Error("Existing Inspector Runtime probe timeout"))
      }, 5000)
    socket.addEventListener("open", () =>
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression: "process.pid", returnByValue: true },
        }),
      ),
    )
    socket.addEventListener("error", () => {
      failure = new Error("Existing Inspector socket error")
      socket.close()
    })
    socket.addEventListener("message", event => {
      try {
        const value = JSON.parse(String(event.data))
        if (value.id !== 1) return
        assert.equal(value.result?.result?.value, expectedPid)
        received = true
      } catch (error) {
        failure = error
      }
      socket.close()
    })
    socket.addEventListener("close", () => {
      clearTimeout(timer)
      failure
        ? reject(failure)
        : received
          ? resolve(true)
          : reject(new Error("Inspector closed before Runtime result"))
    })
  })
}
/** 准备与执行分开，创建夹具时不启动 PM2。 */
export async function createCachedUpgradeFixture({
  pm2Root,
  nodePath = process.execPath,
  oldGuardSource,
  newGuardSource,
  newManifest,
  newManifestSha256,
  signal,
}) {
  const prerequisites = await ensureCachedUpgradePrerequisites({ pm2Root, nodePath })
  assert.ok(["win32", "linux"].includes(process.platform))
  for (const item of [pm2Root, nodePath, oldGuardSource, newGuardSource, newManifest])
    assert.ok(path.isAbsolute(item), "All input paths must be explicit")
  nodePath = fs.realpathSync.native(nodePath)
  pm2Root = fs.realpathSync.native(pm2Root)
  const packageJson = JSON.parse(read(path.join(pm2Root, "package.json")))
  assert.equal(packageJson.name, "pm2")
  const oldManifestFile = path.join(oldGuardSource, "../guard-build.json")
  const oldFiles = manifest(oldGuardSource, oldManifestFile, historicalHash)
  const newFiles = manifest(newGuardSource, newManifest, newManifestSha256)
  assert.ok(
    newFiles["dist/pm2/agent-v2.js"],
    "The candidate must include the new actual versioned agent",
  )
  const closureMetadata = JSON.parse(read(path.join(tests, "fixtures/pm2-r26/metadata.json")))
  assert.equal(closureMetadata.productManifestSha256, historicalHash)
  for (const item of closureMetadata.files)
    assert.equal(sha(path.join(oldGuardSource, "dist", item.path)), item.sha256)
  const installedBefore = regularTree(pm2Root)
  const peer = await createEnvironmentFixture({
    mode: "managed",
    label: "cupo",
    guardSource: oldGuardSource,
  })
  const target = await createEnvironmentFixture({
    mode: "managed",
    label: "cupn",
    guardSource: newGuardSource,
  })
  const runRoot = target.runRoot,
    stateRoot = path.join(runRoot, "cached-upgrade")
  fs.mkdirSync(stateRoot)
  const home =
    process.platform === "linux"
      ? fs.mkdtempSync(path.join(os.tmpdir(), "gcu-"))
      : path.join(stateRoot, "pm2-home")
  for (const dir of ["", "logs", "pids", "modules"])
    fs.mkdirSync(path.join(home, dir), { recursive: true })
  write(path.join(home, "module_conf.json"), {})
  fs.writeFileSync(path.join(home, "touch"), "test-owned\n")
  const socketProof = []
  if (process.platform === "linux") {
    const servers = []
    try {
      for (const name of ["rpc.sock", "pub.sock"]) {
        const file = path.join(home, name),
          server = net.createServer()
        servers.push(server)
        assert.ok(Buffer.byteLength(file) <= 100)
        await new Promise((resolve, reject) => {
          server.once("error", reject)
          server.listen(file, resolve)
        })
        socketProof.push({
          path: file,
          bytes: Buffer.byteLength(file),
          realBind: fs.lstatSync(file).isSocket(),
        })
      }
    } finally {
      await Promise.all(
        servers.filter(s => s.listening).map(s => new Promise(resolve => s.close(resolve))),
      )
    }
  }
  const nonce = randomBytes(24).toString("hex"),
    helper = path.join(tests, "pm2-cached-upgrade-daemon.cjs")
  const configFile = path.join(stateRoot, "closed-control.json")
  write(configFile, {
    nonce,
    hotNonce: randomBytes(24).toString("hex"),
    home,
    pm2Root,
    startupTimeout: peer.settings.startupTimeout,
    shutdownTimeout: peer.settings.shutdownTimeout,
    resident: { id: 1, root: stateRoot, script: path.join(stateRoot, "resident.cjs") },
    peer: {
      id: 0,
      root: canonical(peer.root),
      launcher: canonical(peer.launcher),
      agent: path.join(peer.pluginDir, "dist/pm2-daemon.js"),
    },
    target: {
      id: 2,
      root: canonical(target.root),
      launcher: canonical(target.launcher),
      stable: path.join(target.pluginDir, "dist/pm2-daemon.js"),
      fresh: path.join(target.pluginDir, "dist/pm2/agent-v2.js"),
    },
  })
  if (process.platform === "linux") fs.chmodSync(configFile, 0o600)
  const namespace = path.join(stateRoot, "three-pipe-namespace.cjs")
  let endpoints
  if (process.platform === "win32") {
    assert.doesNotMatch(
      namespace,
      /\s/,
      "PM2 fallback NODE argument splitting requires a no-space private preload path",
    )
    const suffix = randomBytes(16).toString("hex")
    endpoints = Object.fromEntries(
      ["DAEMON_RPC_PORT", "DAEMON_PUB_PORT", "INTERACTOR_RPC_PORT"].map((key, i) => [
        key,
        `\\\\.\\pipe\\guard-cached-${suffix}-${i}`,
      ]),
    )
    fs.writeFileSync(
      namespace,
      `const fs=require("node:fs"),path=require("node:path"),home=${JSON.stringify(home)},names=${JSON.stringify(endpoints)},file=${JSON.stringify(path.join(pm2Root, "paths.js"))};if(path.resolve(process.env.PM2_HOME||"")!==home)throw Error("Foreign PM2_HOME");const old=require(file);require.cache[require.resolve(file)].exports=(...args)=>{const value=old(...args);if(path.resolve(value.PM2_HOME)!==home)throw Error("Foreign PM2 home");const result={...value,...names};if(Object.keys(value).some(k=>!(k in names)&&result[k]!==value[k]))throw Error("Unexpected PM2 change");fs.appendFileSync(${JSON.stringify(path.join(stateRoot, "namespace.jsonl"))},JSON.stringify({pid:process.pid,changedKeys:Object.keys(names),endpoints:names})+"\\n");return result};\n`,
    )
  }
  const env = allowlistedEnvironment(home),
    cliEnv = { ...env }
  if (process.platform === "win32") cliEnv.PM2_NODE_OPTIONS = `--require=${namespace}`
  const commands = [],
    observed = new Map(),
    pending = new Map(),
    phases = []
  const report = {
    schemaVersion: 1,
    platform: process.platform,
    node: { path: nodePath, sha256: sha(nodePath) },
    pm2: packageJson.version,
    status: "prepared-not-started",
    runRoot,
    peerRoot: peer.runRoot,
    home,
    source: {
      oldManifestSha256: historicalHash,
      newManifestSha256,
      oldFiles: Object.keys(oldFiles).length,
      newFiles: Object.keys(newFiles).length,
      helperSha256: sha(helper),
      fixtureSha256: sha(fileURLToPath(import.meta.url)),
      closureMetadata,
    },
    socketProof,
    endpoints,
    phases,
    commands,
    actions: [],
    receipts: [],
    cleanupDiagnostics: { censusErrors: [], controlErrors: [], scopeErrors: [] },
    limitations: [
      "Self-authored closed parent IPC stays connected; the real Daemon.js remains process.argv[1] and all app lifecycle commands use original CLI",
      "Normally ready old peer does not exercise an active pending legacy callback",
      "Old peer original log chain is not repaired by this fixture; target log gate receipts and any remaining errors reported separately",
    ],
  }
  const save = () => write(path.join(stateRoot, "report.json"), report)
  write(path.join(stateRoot, "installed-pm2-files-before.json"), installedBefore)
  report.installedPm2FilesManifest = {
    file: "installed-pm2-files-before.json",
    sha256: sha(path.join(stateRoot, "installed-pm2-files-before.json")),
    count: Object.keys(installedBefore).length,
    scope:
      "PM2 package directory only; the matrix wrapper must separately pin flattened resolved dependencies",
  }
  report.failureReclaimPreflight = {
    receiptFile: prerequisites.receiptFile,
    receiptSha256: prerequisites.receiptSha256,
    receipt: prerequisites.receipt,
  }
  report.budgets = {
    workMilliseconds: 1080000,
    outerTestMilliseconds: 1200000,
    cliMilliseconds: 90000,
    readyMilliseconds: 30000,
    onlineMilliseconds: 90000,
    scopeExitMilliseconds: 30000,
    normalKillMilliseconds: 45000,
    failureReclaimMilliseconds: 15000,
  }
  report.physicalIdentities = []
  save()
  const boundRoots = new Map(),
    trustedRootHistory = new Map()
  const recordCensusError = value => {
    const text = typeof value === "string" ? value : value.stack || String(value)
    if (!report.cleanupDiagnostics.censusErrors.includes(text))
      report.cleanupDiagnostics.censusErrors.push(text)
  }
  const capture = (expectedRoot, workerPid) => {
    try {
      assert.ok(
        expectedRoot && boundRoots.get(expectedRoot.pid) === expectedRoot,
        "A root must be independently bound before snapshot admission",
      )
      const daemonBefore = identity(daemon.pid),
        rootBefore = identity(expectedRoot.pid)
      const rows = snapshot(expectedRoot.pid),
        physical = observeBoundScope(
          {
            rows,
            expectedRoot,
            expectedDaemon: daemon,
            daemonBefore,
            rootBefore,
            daemonAfter: identity(daemon.pid),
            rootAfter: identity(expectedRoot.pid),
            workerPid,
          },
          row => {
            const value = physicalDetails(row, prerequisites.powershell?.resolved)
            assert.ok(value, "Candidate native identity disappeared")
            return value
          },
        )
      const accepted = admitOwnedScope(observed, {
        rows,
        physical,
        expectedRoot,
        expectedDaemon: daemon,
        daemonBefore,
        daemonAfter: identity(daemon.pid),
        rootBefore,
        rootAfter: identity(expectedRoot.pid),
        workerPid,
      })
      for (const value of physical)
        if (
          !report.physicalIdentities.some(row => row.pid === value.pid && row.start === value.start)
        )
          report.physicalIdentities.push(value)
      return accepted
    } catch (error) {
      recordCensusError(error)
      throw error
    }
  }
  const capturePrevious = pid => {
    const expected = boundRoots.get(pid)
    assert.ok(expected, "Numeric PID was never admitted")
    return capture(expected)
  }
  const applicationSpecs = {
    "old-peer": { id: 0, name: "guard-old-peer", script: peer.launcher, cwd: peer.root },
    "new-target": { id: 2, name: "guard-new-target", script: target.launcher, cwd: target.root },
    resident: {
      id: 1,
      name: "guard-unrelated",
      script: path.join(stateRoot, "resident.cjs"),
      cwd: stateRoot,
    },
  }
  const bindApplication = async (pid, application, workerPid) => {
    const spec = applicationSpecs[application]
    assert.ok(spec)
    assertDaemon()
    const before = (await control("health")).slots.find(row => row.id === spec.id)
    const listRow = (await list()).find(row => row.pm_id === spec.id)
    const after = (await control("health")).slots.find(row => row.id === spec.id)
    assert.ok(before && after && listRow, "Expected actual God/jlist application is missing")
    assert.deepEqual(after, before, "Held God child birth changed during jlist binding")
    assert.equal(before.pid, pid)
    assert.equal(listRow.pid, pid)
    assert.equal(listRow.name, spec.name)
    assert.equal(before.uniqueId, listRow.pm2_env.unique_id)
    assert.equal(canonical(before.script), canonical(spec.script))
    assert.equal(canonical(listRow.pm2_env.pm_exec_path), canonical(spec.script))
    assert.equal(canonical(before.cwd), canonical(spec.cwd))
    assert.equal(canonical(listRow.pm2_env.pm_cwd), canonical(spec.cwd))
    assert.equal(before.identity.parent, daemon.pid)
    assert.ok(
      sameBirth(before.identity, identity(pid)),
      "Actual native root differs from its held God ChildProcess birth",
    )
    const root = before.identity
    // 绑定依据真实原生 ChildProcess 对象，而非重新取得的快照。
    trustedRootHistory.set(`${root.pid}:${root.start}`, { ...root })
    boundRoots.set(pid, root)
    try {
      return capture(root, workerPid)
    } catch (error) {
      boundRoots.delete(pid)
      throw error
    }
  }
  const controlled = async (value, application) => {
    assert.ok(Number.isSafeInteger(value.hostPid) && Number.isSafeInteger(value.workerPid))
    assert.notEqual(value.hostPid, value.workerPid)
    const rows = await bindApplication(value.hostPid, application, value.workerPid),
      host = rows.find(row => row.pid === value.hostPid),
      worker = rows.find(row => row.pid === value.workerPid)
    assert.ok(host && worker, "Both controlled identities must actually exist")
    assert.equal(
      worker.parent,
      host.pid,
      "The reported worker must be the controlled host's direct child",
    )
    ;(report.controlledIdentities ||= []).push({
      application,
      at: Date.now(),
      host,
      worker,
      recoveryCount: value.recoveryCount,
    })
    return rows
  }
  let daemon,
    child,
    requestId = 0,
    baselineHealth,
    residentState,
    peerState,
    inspectorUrl,
    finishPromise,
    deadline
  const remaining = limit => {
    if (signal?.aborted) throw new Error("Cached upgrade case was cancelled")
    const left = (deadline ?? Date.now() + limit) - Date.now()
    assert.ok(left > 0, "Cached upgrade work deadline exhausted")
    return Math.min(limit, left)
  }
  const defaultPid = path.join(process.env.PM2_HOME || path.join(os.homedir(), ".pm2"), "pm2.pid")
  const defaultBefore = { exists: fs.existsSync(defaultPid), value: read(defaultPid) }
  function assertDaemon() {
    assert.ok(daemon)
    assert.deepEqual(identity(daemon.pid), daemon)
    assert.equal(Number(read(path.join(home, "pm2.pid"))), daemon.pid)
  }
  function privateDaemonState() {
    try {
      const file = path.join(home, "pm2.pid")
      if (!fs.existsSync(file)) return classifyPrivateDaemon(daemon, { present: false })
      assert.ok(fs.lstatSync(file).isFile(), "Private pid file is not regular")
      const content = fs.readFileSync(file, "utf8").trim()
      assert.match(content, /^\d+$/)
      const pid = Number(content)
      return classifyPrivateDaemon(daemon, {
        present: true,
        pid,
        current: Number.isSafeInteger(pid) && pid > 1 ? identity(pid) : undefined,
      })
    } catch (error) {
      return classifyPrivateDaemon(daemon, { error: error.message })
    }
  }
  function requirePrivateGone() {
    const value = privateDaemonState()
    report.privateDaemonFinalState = value
    assert.equal(
      value.status,
      "none-live",
      "A live replacement or unknown private daemon prevents confirmed cleanup",
    )
  }
  const cli = async args => {
    assertDaemon()
    const record = {
      at: Date.now(),
      action: args[0],
      route: args.includes(targetConfig)
        ? "target-config"
        : args.includes(peerConfig)
          ? "peer-config"
          : "name",
    }
    commands.push(record)
    try {
      const result = await execute(
        nodePath,
        [
          ...(process.platform === "win32" ? ["--require", namespace] : []),
          path.join(pm2Root, "bin/pm2"),
          ...args,
          "--silent",
        ],
        {
          cwd: stateRoot,
          env: cliEnv,
          windowsHide: true,
          timeout: remaining(90000),
          signal,
          maxBuffer: 4 * 1024 * 1024,
        },
      )
      assertDaemon()
      record.status = "passed"
      return result.stdout.trim()
    } catch (error) {
      record.status = "failed"
      record.code = error.code
      throw new Error(`Private PM2 ${args[0]} failed (${error.code})`)
    } finally {
      save()
    }
  }
  const list = async () => JSON.parse(await cli(["jlist"]))
  const control = command =>
    new Promise((resolve, reject) => {
      assertDaemon()
      const id = ++requestId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Closed IPC ${command} timeout`))
      }, remaining(10000))
      pending.set(id, {
        resolve: value => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      })
      child.send({ channel, nonce, id, command }, error => {
        if (error) {
          pending.get(id)?.reject(error)
          pending.delete(id)
        }
      })
    })
  function phase(label, staged = false) {
    peer.verifyCoreHashes()
    target.verifyCoreHashes()
    for (const [name, expected] of Object.entries(oldFiles))
      assert.equal(sha(path.join(peer.pluginDir, name)), expected)
    const files = Object.fromEntries(
      Object.keys(newFiles).map(name => [name, sha(path.join(target.pluginDir, name))]),
    )
    for (const [name, expected] of Object.entries(newFiles)) {
      const old = staged && closureMetadata.files.find(item => name === "dist/" + item.path)
      assert.equal(files[name], old ? old.sha256 : expected, label + ":" + name)
    }
    const file = path.join(stateRoot, `phase-${phases.length}-${label}.json`)
    write(file, { label, staged, files })
    phases.push({ label, staged, at: Date.now(), sha256: sha(file), file })
    save()
  }
  const declare = (file, app) => fs.writeFileSync(file, privateAppDeclaration(app))
  const peerConfig = path.join(stateRoot, "old-peer.config.cjs"),
    targetConfig = path.join(stateRoot, "new-target.config.cjs"),
    residentConfig = path.join(stateRoot, "resident.config.cjs")
  for (const [app, name, config] of [
    [peer, "guard-old-peer", peerConfig],
    [target, "guard-new-target", targetConfig],
  ])
    declare(config, {
      name,
      script: path.join(app.root, "app.js"),
      cwd: app.root,
      exec_mode: "fork",
      instances: 1,
      interpreter: nodePath,
      merge_logs: true,
      error_file: path.join(stateRoot, `${name}-error.log`),
      out_file: path.join(stateRoot, `${name}-output.log`),
      env: { app_type: "pm2" },
    })
  const residentFile = path.join(stateRoot, "resident.cjs"),
    residentTelemetry = path.join(stateRoot, "resident-telemetry.json")
  fs.writeFileSync(
    residentFile,
    `const fs=require("node:fs"),crypto=require("node:crypto");const sample=()=>fs.writeFileSync(${JSON.stringify(residentTelemetry)},JSON.stringify({pid:process.pid,at:Date.now(),digest:crypto.createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.keys(process.env).sort().map(k=>[k,process.env[k]])))).digest("hex"),nodeOptionsAbsent:!("NODE_OPTIONS" in process.env),pm2NodeOptionsAbsent:!("PM2_NODE_OPTIONS" in process.env)}));sample();setInterval(sample,100);\n`,
  )
  declare(residentConfig, {
    name: "guard-unrelated",
    script: residentFile,
    cwd: stateRoot,
    exec_mode: "fork",
    instances: 1,
    interpreter: nodePath,
  })
  const refuseAutostart = path.join(stateRoot, "refuse-daemon-autostart.cjs")
  fs.writeFileSync(
    refuseAutostart,
    `const path=require("node:path");if(path.resolve(process.env.PM2_HOME||"")!==${JSON.stringify(path.resolve(home))})throw Error("Foreign private cleanup HOME");const Client=require(${JSON.stringify(path.join(pm2Root, "lib/Client.js"))});if(typeof Client.prototype.launchDaemon!=="function")throw Error("Unknown PM2 client shape");Client.prototype.launchDaemon=function(){throw Error("Private cleanup refuses automatic daemon creation")};\n`,
  )
  const declarationFiles = [peerConfig, targetConfig, residentConfig, residentFile, refuseAutostart]
  const configHashes = declarationFiles.map(sha)
  report.cleanupAutostartGuard = {
    file: refuseAutostart,
    sha256: sha(refuseAutostart),
    scope:
      "Only the separately proven original private daemon cleanup CLI; its original RPC kill is unchanged, automatic new daemon fallback throws",
  }
  const appState = row => ({
    id: row.pm_id,
    pid: row.pid,
    identity: identity(row.pid),
    counter: row.pm2_env.restart_time,
    uniqueId: row.pm2_env.unique_id,
    env: digest(row.pm2_env.env),
    script: row.pm2_env.pm_exec_path,
    cwd: row.pm2_env.pm_cwd,
    interpreter: row.pm2_env.exec_interpreter,
    args: row.pm2_env.node_args,
  })
  const assertNoPreload = row => {
    for (const key of ["NODE_OPTIONS", "PM2_NODE_OPTIONS"])
      assert.equal(Object.hasOwn(row.pm2_env.env, key), false)
    assert.doesNotMatch(
      JSON.stringify(row.pm2_env.node_args || []),
      /--require|namespace|pm2-preload/,
    )
  }
  async function invariants({ peerMayChange = false, afterHot = false } = {}) {
    assertDaemon()
    const health = await control("health")
    assert.equal(health.environmentDigest, baselineHealth.environmentDigest)
    assert.equal(health.inspectorUrl, inspectorUrl)
    assert.equal(health.nodeOptionsAbsent, true)
    assert.equal(health.pm2NodeOptionsAbsent, true)
    await probeInspector(inspectorUrl, daemon.pid)
    const rows = await list(),
      resident = rows.find(row => row.name === "guard-unrelated"),
      oldPeer = rows.find(row => row.name === "guard-old-peer")
    assert.deepEqual(appState(resident), residentState)
    assertNoPreload(resident)
    assertNoPreload(oldPeer)
    const telemetry = await until(
      () => {
        try {
          const v = JSON.parse(read(residentTelemetry))
          return v.at >= Date.now() - 2000 ? v : false
        } catch {
          return false
        }
      },
      "Resident telemetry stale",
      10000,
    )
    assert.equal(telemetry.pid, residentState.pid)
    assert.equal(telemetry.digest, report.residentRuntime.digest)
    assert.equal(telemetry.nodeOptionsAbsent, true)
    assert.equal(telemetry.pm2NodeOptionsAbsent, true)
    if (!peerMayChange) assert.deepEqual(appState(oldPeer), peerState)
    const receipt = await control("query")
    assertUpgradeReceipt(receipt, { afterHot })
    report.receipts.push({ at: Date.now(), ...receipt })
    assert.deepEqual(declarationFiles.map(sha), configHashes)
    assert.deepEqual({ exists: fs.existsSync(defaultPid), value: read(defaultPid) }, defaultBefore)
    save()
    return rows
  }
  async function start() {
    assert.equal(child, undefined)
    deadline = Date.now() + 1080000
    phase("prepared")
    const daemonEnv = {
      ...env,
      GUARD_TEST_PM2_CACHED_UPGRADE_DAEMON: "1",
      GUARD_TEST_PM2_UPGRADE_CONTROL: configFile,
    }
    const fd = fs.openSync(path.join(home, "pm2.log"), "a")
    try {
      child = spawn(
        nodePath,
        [
          "--inspect=127.0.0.1:0",
          ...(process.platform === "win32" ? ["--require", namespace] : []),
          "--require",
          helper,
          path.join(pm2Root, "lib/Daemon.js"),
        ],
        {
          cwd: stateRoot,
          env: daemonEnv,
          windowsHide: true,
          detached: true,
          stdio: ["ignore", fd, fd, "ipc"],
        },
      )
    } finally {
      fs.closeSync(fd)
    }
    report.spawnedDaemonPid = child.pid
    child.on("message", message => {
      if (message?.channel === channel && Number.isSafeInteger(message.id)) {
        const entry = pending.get(message.id)
        if (!entry) return
        pending.delete(message.id)
        message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result)
      }
    })
    child.on("exit", (code, signal) => {
      report.daemonNativeExit = { code, signal }
      for (const entry of pending.values()) entry.reject(new Error("Private daemon exited"))
      pending.clear()
    })
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Private daemon ready timeout")),
        remaining(30000),
      )
      child.once("error", e => {
        clearTimeout(timer)
        reject(e)
      })
      child.once("exit", code => {
        clearTimeout(timer)
        reject(new Error(`Private daemon exited ${code}`))
      })
      child.on("message", value => {
        if (value?.online && value.pid === child.pid) {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    ready.catch(() => {})
    await ready
    daemon = await until(
      () => identity(child.pid),
      "New daemon native identity unavailable",
      remaining(5000),
    )
    assert.equal(daemon.parent, process.pid, "New daemon is not our creator ChildProcess")
    assert.equal(child.exitCode, null)
    assert.equal(child.signalCode, null)
    const daemonBirth = physicalDetails(daemon, prerequisites.powershell?.resolved)
    assert.ok(daemonBirth)
    assert.equal(canonical(daemonBirth.executable), canonical(nodePath))
    report.daemonIdentity = daemon
    assertDaemon()
    baselineHealth = await control("health")
    assert.equal(baselineHealth.pid, child.pid)
    boundRoots.set(daemon.pid, daemonBirth)
    trustedRootHistory.set(`${daemon.pid}:${daemon.start}`, { ...daemonBirth })
    capture(daemonBirth)
    inspectorUrl = baselineHealth.inspectorUrl
    assert.ok(inspectorUrl)
    await probeInspector(inspectorUrl, daemon.pid)
    report.preExistingInspector = { url: inspectorUrl, runtimePidVerified: true }
    assert.equal((await list()).length, 0)
    await cli(["start", peerConfig])
    const initialPeer = await peer.waitOnline(1, { timeout: remaining(90000) })
    await controlled(initialPeer, "old-peer")
    report.peerHosts = [initialPeer.hostPid]
    await cli(["start", residentConfig])
    const rows = await list()
    assert.equal(rows.find(row => row.name === "guard-old-peer").pm_id, 0)
    assert.equal(rows.find(row => row.name === "guard-unrelated").pm_id, 1)
    peerState = appState(rows.find(row => row.name === "guard-old-peer"))
    residentState = appState(rows.find(row => row.name === "guard-unrelated"))
    await bindApplication(residentState.pid, "resident")
    report.residentRuntime = await until(
      () => {
        try {
          return JSON.parse(read(residentTelemetry))
        } catch {
          return false
        }
      },
      "Resident telemetry absent",
      10000,
    )
    report.oldCapture = await control("capture-old")
    assert.deepEqual(report.oldCapture.legacyIds, [0])
    assert.equal(report.oldCapture.restartMethodCaptured, true)
    phase("old-peer-ready")
    try {
      for (const item of closureMetadata.files)
        fs.copyFileSync(
          path.join(oldGuardSource, "dist", item.path),
          path.join(target.pluginDir, "dist", item.path),
        )
      phase("target-old-staged", true)
      report.targetPrime = await control("prime-target")
      assert.equal(report.targetPrime.registryAndMethodsUnchanged, true)
      assert.equal(report.targetPrime.restartMethodUnchanged, true)
      assert.deepEqual(report.targetPrime.legacyIds, [0])
    } finally {
      for (const item of closureMetadata.files)
        fs.copyFileSync(
          path.join(newGuardSource, "dist", item.path),
          path.join(target.pluginDir, "dist", item.path),
        )
      phase("target-new-restored")
    }
    await cli(["start", targetConfig])
    const initialTarget = await target.waitOnline(1, { timeout: remaining(90000) })
    await controlled(initialTarget, "new-target")
    report.targetHosts = [initialTarget.hostPid]
    let rowsNow = await invariants()
    assert.equal(rowsNow.length, 3)
    let selected = rowsNow.find(row => row.name === "guard-new-target")
    assert.equal(selected.pm_id, 2)
    assert.equal(selected.pm2_env.restart_time, 1)
    assertNoPreload(selected)
    phase("new-target-ready")
    for (let round = 0; round < 10; round++)
      for (const action of ["restart", "reload"]) {
        const previous = await target.status(),
          scope = capturePrevious(previous.hostPid),
          counter = selected.pm2_env.restart_time
        await cli(
          round % 2
            ? [action, targetConfig, "--only", "guard-new-target"]
            : [action, "guard-new-target"],
        )
        const current = await target.waitForStatus(
          s => s.phase === "online" && s.hostPid !== previous.hostPid,
          { timeout: remaining(90000) },
        )
        await waitScopeGone(scope, { timeout: remaining(30000) })
        rowsNow = await invariants()
        selected = rowsNow.find(row => row.name === "guard-new-target")
        assert.equal(selected.pid, current.hostPid)
        assert.equal(selected.pm2_env.restart_time, counter + 1)
        assert.equal(current.recoveryCount, 0)
        assertNoPreload(selected)
        await controlled(current, "new-target")
        report.targetHosts.push(current.hostPid)
        report.actions.push({
          kind: "target",
          action,
          round: round + 1,
          previousHostPid: previous.hostPid,
          hostPid: current.hostPid,
          workerPid: current.workerPid,
          counter: selected.pm2_env.restart_time,
          oldScopeGone: true,
        })
        save()
      }
    for (const action of ["restart", "reload"]) {
      const previous = await peer.status(),
        scope = capturePrevious(previous.hostPid)
      await cli([action, "guard-old-peer"])
      const current = await peer.waitForStatus(
        s => s.phase === "online" && s.hostPid !== previous.hostPid,
        { timeout: remaining(90000) },
      )
      await waitScopeGone(scope, { timeout: remaining(30000) })
      const rows = await invariants({ peerMayChange: true })
      const value = rows.find(row => row.name === "guard-old-peer")
      assert.equal(value.pm2_env.restart_time, peerState.counter + 1)
      peerState = appState(value)
      await controlled(current, "old-peer")
      report.peerHosts.push(current.hostPid)
      report.actions.push({
        kind: "old-peer",
        action,
        previousHostPid: previous.hostPid,
        hostPid: current.hostPid,
        counter: peerState.counter,
        expectedOwnIdentityChange: true,
      })
      save()
    }
    report.oldHotRegister = await control("hot-register-old")
    assert.equal(report.oldHotRegister.allowedOwnSlotRefresh, true)
    assert.equal(report.oldHotRegister.methodsUnchanged, true)
    assert.equal(report.oldHotRegister.result.requiresHandoff, false)
    assertUpgradeReceipt(report.oldHotRegister.receipt, { afterHot: true })
    await invariants({ afterHot: true })
    phase("all-actions-complete")
    report.status = "completed-before-cleanup"
    save()
  }
  const finish = () => (finishPromise ||= finishOnce())
  async function finishOnce() {
    let error,
      forced = false
    const completed = report.status === "completed-before-cleanup"
    report.cleanupControl = { attempts: 0, autostartRefused: true, privateHome: home }
    try {
      if (child && !daemon)
        throw new Error("Spawned daemon identity was not established; cleanup is uncertain")
      if (daemon && identity(daemon.pid)?.start === daemon.start) {
        const stopped = await stopWithIndependentCensus({
          prove: () => {
            assertDaemon()
            return {
              original: daemon,
              current: identity(daemon.pid),
              privateState: privateDaemonState(),
            }
          },
          census: () => capturePrevious(daemon.pid),
          onCensusError: value => {
            recordCensusError(value)
            try {
              save()
            } catch (failure) {
              error ||= failure
              report.cleanupDiagnostics.scopeErrors.push(
                "Census diagnostics persistence failed: " + (failure.stack || String(failure)),
              )
            }
          },
          stop: async () => {
            report.cleanupControl.attempts++
            report.cleanupControl.startedAt = Date.now()
            save()
            try {
              await execute(
                nodePath,
                [
                  ...(process.platform === "win32" ? ["--require", namespace] : []),
                  "--require",
                  refuseAutostart,
                  path.join(pm2Root, "bin/pm2"),
                  "kill",
                  "--silent",
                ],
                {
                  cwd: stateRoot,
                  env: cliEnv,
                  windowsHide: true,
                  timeout: 45000,
                  maxBuffer: 4 * 1024 * 1024,
                },
              )
              report.cleanupControl.nativeExit = { code: 0, signal: null }
            } catch (failure) {
              report.cleanupControl.error = failure.stack
              throw failure
            } finally {
              report.cleanupControl.finishedAt = Date.now()
              save()
            }
          },
        })
        if (stopped.censusError) {
          error ||= new Error(
            "Fresh scope census failed; separately proven original private daemon was still stopped",
          )
        }
      }
      if (child) {
        await until(
          () => report.daemonNativeExit,
          "Creator did not receive the private daemon native exit",
          5000,
        )
        assert.equal(report.daemonNativeExit.code, 0, "Private daemon native exit was not zero")
        assert.equal(report.daemonNativeExit.signal, null)
      }
      await waitScopeGone([...observed.values()])
      requirePrivateGone()
      report.cleanup = {
        confirmed: true,
        forced: false,
        graceful: true,
        observed: [...observed.values()],
      }
    } catch (value) {
      error ||= value
      report.cleanupDiagnostics.controlErrors.push(
        value.controlError || value.stack || String(value),
      )
      report.cleanup = {
        confirmed: false,
        forced: false,
        graceful: false,
        observed: [...observed.values()],
        error: value.stack,
      }
      try {
        if (daemon && boundRoots.has(daemon.pid) && identity(daemon.pid)?.start === daemon.start)
          capturePrevious(daemon.pid)
      } catch (failure) {
        recordCensusError(failure)
      }
      try {
        const live = [...observed.values()].filter(
          previous => identity(previous.pid)?.start === previous.start,
        )
        if (live.length) {
          forced = true
          report.cleanup.forced = true
          const native = new Map(
            report.physicalIdentities.map(row => [`${row.pid}:${row.start}`, row]),
          )
          report.cleanup.reclaim = await reclaimOwned(
            live.reverse().map(row => native.get(`${row.pid}:${row.start}`) || row),
            observed,
            prerequisites,
          )
        }
        await waitScopeGone([...observed.values()], { timeout: 10000 })
        if (child)
          await until(
            () => report.daemonNativeExit,
            "Unconfirmed native exit after failure reclaim",
            2000,
          )
        report.cleanup.confirmed = !child || Boolean(report.daemonNativeExit)
      } catch (failure) {
        report.cleanup.reclaimError = failure.stack
        report.cleanupDiagnostics.scopeErrors.push(failure.stack || String(failure))
      }
    }
    const finalPrivateState = privateDaemonState()
    report.privateDaemonFinalState = finalPrivateState
    if (finalPrivateState.status !== "none-live") {
      report.cleanup.confirmed = false
      report.cleanup.graceful = false
      const privateError = new Error(
        "Live replacement or unknown private PM2 daemon remains; refusing PID-only adoption or signaling",
      )
      error ||= privateError
      report.cleanup.privateDaemonError = {
        status: finalPrivateState.status,
        error: privateError.message,
      }
    }
    const trustedRootExits = observeOriginalExits([...trustedRootHistory.values()], identity),
      admittedRowExits = observeOriginalExits([...observed.values()], identity)
    for (const value of [...trustedRootExits, ...admittedRowExits])
      if (value.status === "unknown")
        report.cleanupDiagnostics.scopeErrors.push(
          value.error || `Unknown exit metadata for ${value.expected.pid}:${value.expected.start}`,
        )
    report.cleanup.trustedRootExits = {
      scope:
        "Roots previously bound to the actual creator or God ChildProcess; OS birth-identity absence is not a per-God-child native exit-code receipt",
      identities: trustedRootExits,
      allOriginalIdentitiesAbsent: trustedRootExits.every(value => value.originalExited),
      creatorDaemonNativeExit: report.daemonNativeExit || null,
    }
    report.cleanup.admittedRowExits = {
      scope:
        "Only identities atomically admitted before cleanup; not an exhaustive descendant history",
      identities: admittedRowExits,
      allOriginalIdentitiesAbsent: admittedRowExits.every(value => value.originalExited),
    }
    if (
      !report.cleanup.trustedRootExits.allOriginalIdentitiesAbsent ||
      !report.cleanup.admittedRowExits.allOriginalIdentitiesAbsent
    ) {
      error ||= new Error("A trusted root or admitted original identity is still live or unknown")
      report.cleanup.confirmed = false
      report.cleanup.graceful = false
    }
    // 未确定结果的用例不能因 IPC 无限存活；仅断开或 unref 自有创建者句柄，不向其他进程发信号。
    if (child?.connected) child.disconnect()
    child?.unref()
    try {
      await peer.finish({ stop: false, timeout: 2000 })
      await target.finish({ stop: false, timeout: 2000 })
    } catch (failure) {
      error ||= failure
      report.fixtureFinalizationError = failure.stack
      report.cleanupDiagnostics.scopeErrors.push(failure.stack || String(failure))
      report.cleanup.confirmed = false
      report.cleanup.graceful = false
    }
    report.cleanup.scopeObservationComplete =
      report.cleanupDiagnostics.censusErrors.length === 0 &&
      report.cleanupDiagnostics.scopeErrors.length === 0 &&
      finalPrivateState.status === "none-live"
    report.cleanup.scopeObservationLimit =
      "Whether requested point-in-time census and bound-identity exit checks completed without error; never proof of exhaustive descendant history"
    try {
      phase("final-after-cleanup-attempt")
      assert.deepEqual(declarationFiles.map(sha), configHashes)
      assert.deepEqual(regularTree(pm2Root), installedBefore)
      manifest(oldGuardSource, oldManifestFile, historicalHash)
      manifest(newGuardSource, newManifest, newManifestSha256)
      assert.deepEqual(
        { exists: fs.existsSync(defaultPid), value: read(defaultPid) },
        defaultBefore,
      )
      Object.assign(report.cleanup, {
        installedPm2Unchanged: true,
        sourceBuildsUnchanged: true,
        defaultPidFileUnchanged: true,
      })
      report.inputAttestation = {
        verified: true,
        pointInTimeAfterCleanupAttempt: true,
        cleanupConfirmed: report.cleanup.confirmed,
      }
    } catch (failure) {
      error ||= failure
      report.inputVerificationError = failure.stack
      report.inputAttestation = { verified: false, error: failure.stack }
    }
    const daemonText = read(path.join(home, "pm2.log")),
      errorTexts = ["guard-old-peer", "guard-new-target"].map(name => ({
        name,
        text: read(path.join(stateRoot, `${name}-error.log`)),
      }))
    const hashText = value => createHash("sha256").update(value).digest("hex")
    report.logFiles = {
      daemon: { bytes: Buffer.byteLength(daemonText), sha256: hashText(daemonText) },
      errors: errorTexts.map(value => ({
        name: value.name,
        bytes: Buffer.byteLength(value.text),
        sha256: hashText(value.text),
        stderrTail: value.text.slice(-16000),
      })),
    }
    report.rawDaemonStreamErrors = daemonText
      .split(/\r?\n/)
      .filter(line => line.includes("ERR_STREAM_DESTROYED"))
    report.declaredLogChecksClear = false
    report.daemonLogDiagnostics = daemonText
      .split(/\r?\n/)
      .filter(line =>
        /ERR_STREAM_DESTROYED|log-drain|log-not-drained|log-drained|barrier-failed/.test(line),
      )
    try {
      Object.assign(
        report,
        summarizeDeclaredLogs({
          daemonText,
          errorTexts,
          targetHosts: report.targetHosts || [],
          peerHosts: report.peerHosts || [],
        }),
      )
      if (completed && !error) {
        assert.equal(report.targetHosts.length, 21)
        assert.equal(report.targetLogGateCoverage.actualReceipts, 21)
        assert.equal(
          report.targetLogGateCoverage.exactlyOnePerHost,
          true,
          "Each stopped new controlled host needs one actual log gate receipt",
        )
        assert.equal(
          report.oldPeerLogGateReceipts.length,
          0,
          "Historical peer logging must keep its original chain",
        )
      }
    } catch (failure) {
      error ||= failure
      report.logGateVerificationError = failure.stack
    }
    report.finishedAt = Date.now()
    report.status =
      completed && !error && !forced ? "passed-with-log-diagnostics-separate" : "failed"
    if (error) report.finalizationError = error.stack
    save()
    if (error) throw error
  }
  return {
    runRoot,
    stateRoot,
    peer,
    target,
    report,
    start,
    finish,
    save,
    async run() {
      let failure, cleanupFailure
      try {
        await start()
      } catch (error) {
        failure = error
        report.error = error.stack
      }
      try {
        await finish()
      } catch (error) {
        cleanupFailure = error
      }
      if (failure && cleanupFailure) throw new AggregateError([failure, cleanupFailure])
      if (failure) throw failure
      if (cleanupFailure) throw cleanupFailure
    },
  }
}
