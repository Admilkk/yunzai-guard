import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile, execFileSync, spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { promisify } from "node:util"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createEnvironmentFixture, snapshot, waitScopeGone } from "./environment-fixture.mjs"

const execute = promisify(execFile)
const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const canonical = value => fs.realpathSync(value).toLowerCase()
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, stableValue(value[key])]),
    )
  return value
}

export const environmentDigest = value =>
  createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex")

function identity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined
  return snapshot(pid).find(row => row.pid === pid)
}

function processTicks(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1)
  const script = `try{$p=[Diagnostics.Process]::GetProcessById(${pid});$p.StartTime.ToUniversalTime().Ticks.ToString();$p.Dispose()}catch{exit 0}`
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  }).trim()
}

function sourceHashes(directory, prefix = "") {
  const result = {}
  for (const entry of fs.readdirSync(path.join(directory, prefix), { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(entry.name)) continue
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory()) Object.assign(result, sourceHashes(directory, relative))
    else if (entry.isFile()) result[relative] = digest(path.join(directory, relative))
  }
  return result
}

function terminateOwned(identities) {
  const rows = identities.filter(
    row => Number.isSafeInteger(row.pid) && row.pid > 1 && /^\d{17}$/.test(row.start),
  )
  if (!rows.length) return
  const encoded = Buffer.from(JSON.stringify(rows), "utf8").toString("base64")
  const script = `$rows=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json;foreach($row in $rows){try{$p=[Diagnostics.Process]::GetProcessById([int]$row.pid);$started=$p.StartTime.ToUniversalTime();if($started.ToString('yyyyMMddHHmmssfff') -eq $row.start -and (!$row.ticks -or $started.Ticks.ToString() -eq $row.ticks)){$p.Kill();[void]$p.WaitForExit(5000)};$p.Dispose()}catch{}}`
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    stdio: "ignore",
    timeout: Math.max(15000, rows.length * 6000),
  })
}

function resolveLauncher(pluginDir, requested) {
  let relative = requested
  if (path.isAbsolute(requested)) {
    relative = path.relative(pluginDir, requested)
    if (relative.startsWith("..")) relative = path.relative(repository, requested)
  }
  const candidate = path.resolve(pluginDir, relative)
  const inside = path.relative(pluginDir, candidate)
  assert.ok(
    inside && !inside.startsWith(`..${path.sep}`) && inside !== ".." && !path.isAbsolute(inside),
    "The tested launcher must be inside the copied Guard plugin",
  )
  assert.ok(fs.statSync(candidate).isFile(), "Build the selected launcher before testing")
  return candidate
}

/** 为已安装的真实 PM2 CLI 和守护进程建立私有命名空间，仅修改内存中的三个 IPC 端点。 */
export async function createWindowsPm2Fixture({
  mode = "managed",
  zeroConfig = false,
  label = zeroConfig
    ? mode === "os-sandbox"
      ? "pm2a-os"
      : "pm2a-m"
    : mode === "os-sandbox"
      ? "pm2n-os"
      : "pm2n-m",
  nodePath = process.env.GUARD_TEST_PM2_NODE || process.execPath,
  interpreter = process.env.GUARD_TEST_PM2_INTERPRETER,
  daemonEntryPath,
  launcher = process.env.GUARD_TEST_PM2_LAUNCHER || "dist/launcher.js",
  pm2Root = process.env.GUARD_TEST_PM2_PACKAGE ||
    path.join(process.env.APPDATA || "", "npm/node_modules/pm2"),
  settings = {},
  app = {},
  compat = !zeroConfig && process.env.GUARD_TEST_PM2_COMPAT !== "0",
} = {}) {
  assert.equal(process.platform, "win32", "This fixture requires Windows")
  if (zeroConfig)
    assert.equal(compat, false, "Zero-config tests must not preload Guard compatibility")
  nodePath = fs.realpathSync(nodePath)
  interpreter ||= nodePath
  assert.ok(interpreter === "node" || path.isAbsolute(interpreter))
  if (interpreter !== "node")
    assert.equal(
      fs.realpathSync(interpreter),
      nodePath,
      "Absolute interpreter must match selected Node",
    )
  pm2Root = fs.realpathSync(pm2Root)
  assert.ok(fs.existsSync(path.join(pm2Root, "bin/pm2")), "An existing PM2 package is required")
  if (daemonEntryPath !== undefined) {
    assert.equal(zeroConfig, true, "An alternate daemon entry is only a zero-config fixture option")
    assert.ok(path.isAbsolute(daemonEntryPath))
    assert.equal(
      canonical(daemonEntryPath),
      canonical(path.join(pm2Root, "lib/Daemon.js")),
      "Alternate daemon entry must identify the same installed PM2 file",
    )
  }
  const installedHashes = sourceHashes(pm2Root)
  const defaultHome = process.env.PM2_HOME || path.join(os.homedir(), ".pm2")
  const defaultPidFile = path.join(defaultHome, "pm2.pid")
  const defaultPidContents = fs.existsSync(defaultPidFile)
    ? fs.readFileSync(defaultPidFile, "utf8")
    : undefined
  const defaultIdentity = identity(Number(defaultPidContents?.trim()))
  const fixture = await createEnvironmentFixture({ mode, label, settings })
  const compatPath = path.join(fixture.pluginDir, "dist/pm2-preload.cjs")
  if (compat)
    assert.ok(fs.existsSync(compatPath), "Build the PM2 compatibility preload before testing")
  const home = path.join(fixture.runRoot, "pm2-home")
  fs.mkdirSync(home, { recursive: true })
  const suffix = randomBytes(16).toString("hex")
  const endpoints = Object.fromEntries(
    ["DAEMON_RPC_PORT", "DAEMON_PUB_PORT", "INTERACTOR_RPC_PORT"].map((key, index) => [
      key,
      `\\\\.\\pipe\\yunzai-guard-pm2-native-${suffix}-${index}`,
    ]),
  )
  const preload = path.join(fixture.runRoot, "pm2-test-namespace.cjs")
  const observations = path.join(fixture.runRoot, "pm2-namespace.jsonl")
  const factory = path.join(pm2Root, "paths.js")
  fs.writeFileSync(
    preload,
    `const fs=require("node:fs"),path=require("node:path");
const expected=${JSON.stringify(home)},endpoints=${JSON.stringify(endpoints)},target=${JSON.stringify(factory)};
if(path.resolve(process.env.PM2_HOME||"")!==expected)throw new Error("Refusing non-test PM2_HOME");
const original=require(target);
require.cache[require.resolve(target)].exports=function(...args){
const value=original(...args);if(path.resolve(value.PM2_HOME)!==expected)throw new Error("PM2 home escaped fixture");
const names=Object.keys(endpoints),result={...value,...endpoints};
if(Object.keys(value).some(key=>!names.includes(key)&&result[key]!==value[key]))throw new Error("Unexpected PM2 change");
fs.appendFileSync(${JSON.stringify(observations)},JSON.stringify({home:value.PM2_HOME,endpoints,changedKeys:names})+"\\n");return result};\n`,
  )
  const keep = [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
    "USERNAME",
    "USERDOMAIN",
    "ComSpec",
    "TEMP",
    "TMP",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "ProgramData",
    "ALLUSERSPROFILE",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "CommonProgramFiles",
    "LANG",
    "TZ",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
  ]
  const env = Object.fromEntries(
    keep.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]),
  )
  Object.assign(env, {
    PATH: path.dirname(nodePath) + path.delimiter + (env.PATH || ""),
    PM2_HOME: home,
    PM2_NO_INTERACTION: "true",
    PM2_DISCRETE_MODE: "true",
    NO_COLOR: "1",
  })
  if (!zeroConfig)
    env.NODE_OPTIONS = `--require "${preload.replaceAll("\\", "/")}"${compat ? ` --require "${compatPath.replaceAll("\\", "/")}"` : ""}`
  const cliEnv = { ...env }
  if (zeroConfig) {
    // 连接与意外退出竞争时，PM2 CLI 可能重启守护进程；失败路径也必须保留私有传输。
    assert.doesNotMatch(preload, /\s/, "PM2 splits PM2_NODE_OPTIONS on spaces")
    cliEnv.PM2_NODE_OPTIONS = `--require=${preload}`
  }
  const commands = []
  const owned = new Map()
  const sessions = new Set()
  let daemonIdentity
  function capture(pid) {
    const rows = snapshot(pid)
    const root = rows.find(row => row.pid === pid)
    if (!root) return []
    const confirmed = new Map([[pid, root]])
    let changed
    do {
      changed = false
      for (const row of rows) {
        const parent = confirmed.get(row.parent)
        if (parent && row.start >= parent.start && !confirmed.has(row.pid)) {
          confirmed.set(row.pid, row)
          changed = true
        }
      }
    } while (changed)
    for (const row of confirmed.values()) owned.set(`${row.pid}:${row.start}`, row)
    return [...confirmed.values()]
  }
  function observeDaemon() {
    const file = path.join(home, "pm2.pid")
    if (!fs.existsSync(file)) return undefined
    const current = identity(Number(fs.readFileSync(file, "utf8").trim()))
    if (!current) return undefined
    assert.notEqual(
      current.pid,
      defaultIdentity?.pid,
      "Test daemon must differ from default daemon",
    )
    if (daemonIdentity)
      assert.deepEqual(
        current,
        daemonIdentity,
        "Private PM2 owner identity changed; refusing foreign process capture",
      )
    if (!daemonIdentity) daemonIdentity = current
    capture(current.pid)
    return current
  }
  async function cli(args, timeout = 90000) {
    assert.equal(env.PM2_HOME, home)
    if (zeroConfig) {
      assert.ok(daemonIdentity, "Start the private daemon explicitly before using its CLI")
      assert.deepEqual(
        identity(daemonIdentity.pid),
        daemonIdentity,
        "Existing daemon identity changed",
      )
    }
    const started = Date.now()
    try {
      const result = await execute(
        nodePath,
        [
          ...(zeroConfig ? ["--require", preload] : []),
          path.join(pm2Root, "bin/pm2"),
          ...args,
          "--silent",
        ],
        {
          cwd: fixture.runRoot,
          env: cliEnv,
          windowsHide: true,
          timeout,
          maxBuffer: 16 * 1024 * 1024,
        },
      )
      commands.push({ action: args[0], status: "passed", elapsedMs: Date.now() - started })
      const current = observeDaemon()
      if (zeroConfig && args[0] !== "kill")
        assert.deepEqual(
          current,
          daemonIdentity,
          "CLI fallback must not replace the existing daemon",
        )
      return result.stdout
    } catch (error) {
      commands.push({ action: args[0], status: "failed", code: error.code })
      observeDaemon()
      throw new Error(
        `Private PM2 ${args[0]} failed (${error.code || "unknown"}); raw output omitted`,
      )
    }
  }
  async function listRaw() {
    const raw = await cli(["jlist"])
    try {
      return JSON.parse(raw.trim())
    } catch {
      throw new Error("Private PM2 jlist was invalid; raw environments omitted")
    }
  }
  async function list() {
    return (await listRaw()).map(row => ({
      id: row.pm_id,
      name: row.name,
      pid: row.pid,
      status: row.pm2_env?.status,
      restarts: row.pm2_env?.restart_time,
      execMode: row.pm2_env?.exec_mode,
      killRetryTime: row.pm2_env?.kill_retry_time,
      exitCode: row.pm2_env?.exit_code,
    }))
  }
  async function daemonEnvironment() {
    assert.ok(daemonIdentity)
    assert.deepEqual(identity(daemonIdentity.pid), daemonIdentity)
    const script = `const p=require(${JSON.stringify(pm2Root)}),c=require("node:crypto");const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;p.connect(e=>{if(e)throw e;p.Client.executeRemote("getReport",{},(e,r)=>{if(e)throw e;process.stdout.write(JSON.stringify({digest:c.createHash("sha256").update(JSON.stringify(stable(r.env))).digest("hex"),nodeOptionsAbsent:!("NODE_OPTIONS" in r.env),pm2NodeOptionsAbsent:!("PM2_NODE_OPTIONS" in r.env)}));p.disconnect()})})`
    const result = await execute(nodePath, ["--require", preload, "-e", script], {
      cwd: fixture.runRoot,
      env: cliEnv,
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    })
    assert.deepEqual(observeDaemon(), daemonIdentity)
    return JSON.parse(result.stdout)
  }
  async function startDaemon({ inspectPort = 0, openInspector = false } = {}) {
    assert.equal(zeroConfig, true, "Explicit daemon startup is for zero-config tests")
    assert.equal(daemonIdentity, undefined, "Private daemon already started")
    for (const directory of ["logs", "pids", "modules"])
      fs.mkdirSync(path.join(home, directory), { recursive: true })
    fs.writeFileSync(path.join(home, "module_conf.json"), "{}\n")
    fs.writeFileSync(path.join(home, "touch"), "test-owned\n")
    const daemonEnv = { ...env }
    delete daemonEnv.NODE_OPTIONS
    delete daemonEnv.PM2_NODE_OPTIONS
    const output = fs.openSync(path.join(home, "pm2.log"), "a")
    const child = spawn(
      nodePath,
      [
        ...(openInspector
          ? [`--inspect=127.0.0.1:${inspectPort ?? 0}`]
          : inspectPort === null
            ? []
            : [`--inspect-port=${inspectPort}`]),
        "--require",
        preload,
        daemonEntryPath || path.join(pm2Root, "lib/Daemon.js"),
      ],
      {
        cwd: fixture.runRoot,
        env: daemonEnv,
        windowsHide: true,
        detached: true,
        stdio: ["ignore", output, output, "ipc"],
      },
    )
    fs.closeSync(output)
    if (child.pid) {
      daemonIdentity = capture(child.pid).find(row => row.pid === child.pid)
      assert.ok(daemonIdentity, "The directly spawned private daemon must have a live identity")
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Private PM2 daemon readiness timeout")),
        30000,
      )
      child.once("error", error => {
        clearTimeout(timer)
        reject(error)
      })
      child.once("exit", code => {
        clearTimeout(timer)
        reject(new Error(`Private daemon exited: ${code}`))
      })
      child.on("message", message => {
        if (!message?.online || message.pid !== child.pid) return
        clearTimeout(timer)
        child.disconnect()
        resolve()
      })
    })
    child.unref()
    const current = observeDaemon()
    assert.equal(current?.pid, child.pid)
    return current
  }
  const launcherPath = resolveLauncher(fixture.pluginDir, launcher)
  const name = zeroConfig ? `guard-auto-${mode}` : `guard-native-${mode}`
  const unrelatedName = zeroConfig ? "guard-auto-control" : "guard-native-control"
  const unrelatedLog = path.join(fixture.runRoot, "control-lifecycle.jsonl")
  const unrelatedScript = path.join(fixture.runRoot, "control-app.cjs")
  const unrelatedTelemetry = path.join(fixture.runRoot, "control-telemetry.json")
  fs.writeFileSync(
    unrelatedScript,
    `const fs=require("node:fs"),crypto=require("node:crypto");const digest=()=>crypto.createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.keys(process.env).sort().map(key=>[key,process.env[key]])))).digest("hex");const record=event=>fs.appendFileSync(${JSON.stringify(unrelatedLog)},JSON.stringify({event,pid:process.pid,time:Date.now(),envDigest:digest()})+"\\n");const telemetry=()=>fs.writeFileSync(${JSON.stringify(unrelatedTelemetry)},JSON.stringify({pid:process.pid,envDigest:digest(),nodeOptionsAbsent:!("NODE_OPTIONS" in process.env),pm2NodeOptionsAbsent:!("PM2_NODE_OPTIONS" in process.env)}));record("started");telemetry();process.on("message",message=>{if(message==="shutdown"){record("stopped");process.exit(0)}});setInterval(telemetry,1000);if(process.send)process.send("ready");\n`,
  )
  const configPath = path.join(fixture.runRoot, "ecosystem.config.cjs")
  fs.writeFileSync(
    configPath,
    "module.exports=" +
      JSON.stringify(
        {
          apps: [
            {
              name,
              script: zeroConfig ? path.join(fixture.root, "app.js") : launcherPath,
              cwd: fixture.root,
              interpreter,
              exec_mode: "fork",
              instances: 1,
              wait_ready: true,
              listen_timeout: 60000,
              shutdown_with_message: true,
              kill_timeout: 20000,
              kill_retry_time: 100,
              autorestart: true,
              min_uptime: 1000,
              max_restarts: 5,
              stop_exit_codes: [78],
              watch: false,
              out_file: path.join(fixture.runRoot, "application-output.log"),
              error_file: path.join(fixture.runRoot, "application-error.log"),
              merge_logs: true,
              ...(zeroConfig
                ? {
                    wait_ready: false,
                    shutdown_with_message: false,
                    kill_timeout: 10000,
                    exp_backoff_restart_delay: 1000,
                    stop_exit_codes: undefined,
                  }
                : {}),
              ...app,
              ...(zeroConfig ? { filter_env: ["NODE_OPTIONS", "PM2_NODE_OPTIONS"] } : {}),
              env: zeroConfig ? { app_type: "pm2", ...app.env } : { ...app.env, NODE_OPTIONS: "" },
            },
            {
              name: unrelatedName,
              script: unrelatedScript,
              cwd: fixture.runRoot,
              interpreter,
              exec_mode: "fork",
              instances: 1,
              wait_ready: true,
              listen_timeout: 10000,
              shutdown_with_message: true,
              kill_timeout: 10000,
              autorestart: true,
              watch: false,
              ...(zeroConfig ? { filter_env: ["NODE_OPTIONS", "PM2_NODE_OPTIONS"] } : {}),
              env: zeroConfig ? { GUARD_CONTROL_CANARY: suffix } : { NODE_OPTIONS: "" },
            },
          ],
        },
        null,
        2,
      ) +
      "\n",
  )
  const ecosystem = JSON.parse(
    fs.readFileSync(configPath, "utf8").replace(/^module\.exports\s*=\s*/, ""),
  )
  const targetConfigPath = path.join(fixture.runRoot, "target.config.cjs")
  const unrelatedConfigPath = path.join(fixture.runRoot, "resident.config.cjs")
  fs.writeFileSync(
    targetConfigPath,
    "module.exports=" + JSON.stringify({ apps: [ecosystem.apps[0]] }, null, 2) + "\n",
  )
  fs.writeFileSync(
    unrelatedConfigPath,
    "module.exports=" + JSON.stringify({ apps: [ecosystem.apps[1]] }, null, 2) + "\n",
  )
  const applicationHashes = {
    control: digest(unrelatedScript),
    entry: digest(path.join(fixture.pluginDir, "index.js")),
    dist: sourceHashes(path.join(fixture.pluginDir, "dist")),
    native: sourceHashes(path.join(fixture.pluginDir, "native")),
    ecosystem: digest(configPath),
    targetConfig: digest(targetConfigPath),
    unrelatedConfig: digest(unrelatedConfigPath),
  }
  const activePath = path.join(fixture.stateDir, "windows-sandbox-active.json")
  function captureSession() {
    if (!fs.existsSync(activePath)) return
    const activeStat = fs.lstatSync(activePath)
    assert.ok(activeStat.isFile() && activeStat.nlink === 1 && activeStat.size <= 8192)
    const active = JSON.parse(fs.readFileSync(activePath, "utf8"))
    assert.equal(canonical(active.root), canonical(fixture.root), "Foreign sandbox ownership root")
    assert.equal(path.dirname(path.resolve(active.session)).toLowerCase(), canonical(os.tmpdir()))
    assert.match(path.basename(active.session), /^yunzai-guard-windows-[\w-]+$/)
    if (fs.existsSync(active.session))
      assert.equal(canonical(active.session), path.resolve(active.session).toLowerCase())
    sessions.add(active.session)
  }
  function assertPreserved() {
    assert.deepEqual(sourceHashes(pm2Root), installedHashes, "Installed PM2 source changed")
    const currentContents = fs.existsSync(defaultPidFile)
      ? fs.readFileSync(defaultPidFile, "utf8")
      : undefined
    assert.equal(currentContents, defaultPidContents, "Default PM2 PID file changed")
    if (defaultIdentity) assert.deepEqual(identity(defaultIdentity.pid), defaultIdentity)
    assert.deepEqual(
      {
        control: digest(unrelatedScript),
        entry: digest(path.join(fixture.pluginDir, "index.js")),
        dist: sourceHashes(path.join(fixture.pluginDir, "dist")),
        native: sourceHashes(path.join(fixture.pluginDir, "native")),
        ecosystem: digest(configPath),
        targetConfig: digest(targetConfigPath),
        unrelatedConfig: digest(unrelatedConfigPath),
      },
      applicationHashes,
      "Fixture application or Guard source changed",
    )
    const records = fs.readFileSync(observations, "utf8").trim().split("\n").filter(Boolean)
    assert.ok(records.length)
    for (const line of records) {
      const record = JSON.parse(line)
      assert.equal(path.resolve(record.home), home)
      assert.deepEqual(record.endpoints, endpoints)
      assert.deepEqual(record.changedKeys, Object.keys(endpoints))
    }
  }
  let cleanupPromise
  const cleanup = () =>
    (cleanupPromise ||= (async () => {
      captureSession()
      const daemon = observeDaemon()
      if (daemon) capture(daemon.pid)
      try {
        if (daemon) await cli(["kill"], 45000)
      } catch {}
      try {
        await fixture.finish({ timeout: 10000 })
      } catch {}
      // 仅重读本夹具的 owner 记录，不扫描或清理其他会话。
      captureSession()
      for (const session of sessions) {
        const journal = path.join(session, "journal.json")
        if (!fs.existsSync(journal)) continue
        const stat = fs.lstatSync(journal)
        assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 1024 * 1024)
        const value = JSON.parse(fs.readFileSync(journal, "utf8"))
        assert.equal(
          canonical(value.projectRoot),
          canonical(fixture.root),
          "Foreign cleanup journal",
        )
        assert.match(value.profile, /^YunzaiGuard\.[a-f0-9]{32}$/)
        const broker = identity(value.brokerPid)
        if (broker && processTicks(value.brokerPid) === value.brokerCreated) {
          capture(broker.pid)
          owned.set(`${broker.pid}:${broker.start}`, { ...broker, ticks: value.brokerCreated })
        }
      }
      const identities = [...owned.values()]
      try {
        await waitScopeGone(identities, { timeout: 10000 })
      } catch {
        terminateOwned(identities)
        await waitScopeGone(identities, { timeout: 15000 })
      }
      // 确认已观测进程全部退出后再还原；原生清理 API 独立核对 broker 身份并清空 Job。
      const native = await import(
        pathToFileURL(path.join(fixture.pluginDir, "dist/sandbox/windows.js"))
      )
      let journalRecoverySessions = 0
      for (const session of sessions) {
        if (!fs.existsSync(session)) continue
        const hadJournal = fs.existsSync(path.join(session, "journal.json"))
        await native.cleanupWindowsSandbox(native.compileWindowsSandbox(), session)
        if (hadJournal) journalRecoverySessions++
      }
      if (fs.existsSync(activePath)) {
        const active = JSON.parse(fs.readFileSync(activePath, "utf8"))
        assert.equal(canonical(active.root), canonical(fixture.root))
        assert.ok(sessions.has(active.session), "Ownership record changed during cleanup")
        fs.rmSync(activePath)
      }
      await fixture.finish({ stop: false, timeout: 15000 })
      assertPreserved()
      return {
        confirmed: true,
        trackedSessions: sessions.size,
        journalRecoverySessions,
        observedScopesGone: true,
      }
    })())
  return {
    fixture,
    name,
    configPath,
    targetConfigPath,
    unrelatedConfigPath,
    zeroConfig,
    nodePath,
    interpreter,
    interpreterKind: interpreter === "node" ? "node-identifier" : "absolute-node-executable",
    launcherPath,
    compat,
    compatPath,
    unrelatedName,
    unrelatedLog,
    unrelatedTelemetry,
    capture,
    captureSession,
    cleanup,
    nodeVersion: execFileSync(nodePath, ["-p", "process.version"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim(),
    pm2Version: JSON.parse(fs.readFileSync(path.join(pm2Root, "package.json"), "utf8")).version,
    assertPreserved,
    sourceSnapshot: {
      pm2SourceDigest: environmentDigest(installedHashes),
      applicationSourceDigest: environmentDigest(applicationHashes),
      guardDistHashes: applicationHashes.dist,
    },
    pm2: {
      home,
      env,
      commands,
      cli,
      list,
      listRaw,
      daemonEnvironment,
      startDaemon,
      observeDaemon,
      get daemonIdentity() {
        return daemonIdentity
      },
    },
  }
}
