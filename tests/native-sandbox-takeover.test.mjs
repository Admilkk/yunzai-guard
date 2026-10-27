import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import test from "node:test"
import { createEnvironmentFixture, snapshot, until, waitScopeGone } from "./environment-fixture.mjs"

const enabled =
  process.env.GUARD_TEST_NATIVE_TAKEOVER === "1" && ["win32", "linux"].includes(process.platform)
const pluginId = "native-takeover-business"
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
const readJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return undefined
    throw error
  }
}
const lines = file =>
  fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse)
    : []
const normalize = value =>
  process.platform === "win32" ? value.replaceAll("\\", "/").toLowerCase() : value

function environment(extra = {}) {
  const env = { ...process.env, NODE_OPTIONS: "", ...extra }
  for (const key of [
    "pm_id",
    "NODE_APP_INSTANCE",
    "PM2_HOME",
    "app_type",
    "YUNZAI_GUARD_PIPE",
    "YUNZAI_GUARD_RUNTIME_MANIFEST",
    "YUNZAI_GUARD_MANAGED",
    "YUNZAI_GUARD_SANDBOX",
    "YUNZAI_GUARD_PM2_TICKET",
  ])
    delete env[key]
  return env
}

function ownedNodeRoles(fixture, scope, status) {
  let rows
  if (process.platform === "win32") {
    const ids = scope.map(row => row.pid)
    assert.ok(ids.every(id => Number.isSafeInteger(id) && id > 0))
    const command = `$guardPids=@(${ids.join(",")}); @(Get-CimInstance Win32_Process | Where-Object {$guardPids -contains [int]$_.ProcessId -and $_.Name -eq 'node.exe'} | ForEach-Object {@{pid=[int]$_.ProcessId;command=[string]$_.CommandLine}}) | ConvertTo-Json -Compress`
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { encoding: "utf8", windowsHide: true, timeout: 15000 },
    ).trim()
    rows = output ? JSON.parse(output) : []
    if (!Array.isArray(rows)) rows = [rows]
  } else {
    rows = scope.flatMap(({ pid }) => {
      try {
        const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")
        // 真实核心设置 process.title 会覆盖 Linux argv；使用内核可执行文件链接和父进程状态保留身份。
        const executable = fs.readlinkSync(`/proc/${pid}/exe`)
        return path.basename(executable) === path.basename(process.execPath)
          ? [{ pid, command: command.join(" ") }]
          : []
      } catch {
        return []
      }
    })
  }
  const targets = {
    host: path.join(fixture.pluginDir, "dist/host/supervisor.js"),
    core: path.join(fixture.root, "app.js"),
    native: path.join(fixture.pluginDir, "dist/native-sandbox/child.js"),
  }
  const result = Object.fromEntries(Object.keys(targets).map(key => [key, []]))
  for (const row of rows) {
    const role =
      row.pid === status.hostPid
        ? "host"
        : row.pid === status.workerPid
          ? "core"
          : Object.keys(targets).find(key =>
              normalize(row.command).includes(normalize(targets[key])),
            )
    if (role) result[role].push(row.pid)
  }
  return {
    ...result,
    infrastructurePids: scope
      .filter(row => !rows.some(node => node.pid === row.pid))
      .map(row => row.pid),
  }
}

const businessSource = `import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
const own=path.dirname(fileURLToPath(import.meta.url))
const statePath=path.resolve("data/native-takeover/state.json")
const configPath=path.resolve("config/native-takeover.json")
const identity=()=>({pid:process.pid,namespace:process.platform==="linux"?fs.readlinkSync("/proc/self/ns/pid"):null})
const record=(file,value)=>fs.appendFileSync(path.join(own,file),JSON.stringify({...identity(),...value})+"\\n")
record("imports.jsonl",{sandbox:process.env.YUNZAI_GUARD_SANDBOX??null})
export class NativeTakeoverBusiness extends plugin {
  constructor(){super({name:"Native takeover business",rule:[{reg:"^#native-takeover$",fnc:"business"}],task:{name:"Native takeover timer",cron:"* * * * * *",log:false,fnc:function(){record("tasks.jsonl",{task:true})}}})}
  init(){
    const previous=JSON.parse(fs.readFileSync(statePath,"utf8"))
    const config=JSON.parse(fs.readFileSync(configPath,"utf8"))
    const state={...previous,starts:previous.starts+1}
    fs.writeFileSync(statePath,JSON.stringify(state))
    fs.writeFileSync(configPath,JSON.stringify({...config,starts:state.starts}))
    record("initializers.jsonl",{starts:state.starts,seed:state.seed,configSeed:config.seed,statePath,configPath})
    this.addCleanup(()=>record("cleanups.jsonl",{starts:state.starts}))
  }
  async business(e){
    const state=JSON.parse(fs.readFileSync(statePath,"utf8"))
    const config=JSON.parse(fs.readFileSync(configPath,"utf8"))
    record("messages.jsonl",{starts:state.starts,msg:e.msg})
    await this.reply(JSON.stringify({kind:"native-takeover",...identity(),starts:state.starts,seed:state.seed,configSeed:config.seed,statePath,configPath}))
    return true
  }
}
`

const driverSource = `import fs from "node:fs"
import loader from "../../lib/plugins/loader.js"
export class Driver extends plugin {
  constructor(){super({name:"Trusted native takeover test driver",rule:[]})}
  init(){
    const context=globalThis[Symbol.for("yunzai.guard.context.v1")]
    const uninstall=process.env.GUARD_TAKEOVER_FIXTURE_UNINSTALLED==="1"
    if(!context&&!uninstall)return
    Bot.once("online",()=>setTimeout(async()=>{
      const result={corePid:process.pid,generation:context?.generation??null,uninstall,replies:[]}
      try {
        const text="#native-takeover"
        await loader.deal({self_id:"test",user_id:"takeover-user",post_type:"message",message_type:"private",isPrivate:true,message:[{type:"text",text}],raw_message:text,
          reply:async value=>{result.replies.push(JSON.parse(value));return {message_id:"takeover-test"}}})
      }catch(error){result.error=String(error.stack)}
      fs.writeFileSync("data/native-takeover-driver-"+(uninstall?"uninstalled":context.generation)+".json",JSON.stringify(result))
      if(uninstall)await Bot.exit(result.error?1:0)
    },200))
  }
}
`

test(
  "direct node app.js takes over once, restarts one native plugin scope and preserves original business data after Guard removal",
  {
    skip: enabled
      ? false
      : "requires GUARD_TEST_NATIVE_TAKEOVER=1 and Windows AppContainer/Linux bubblewrap",
    timeout: 240000,
  },
  async t => {
    const fixture = await createEnvironmentFixture({
      mode: "managed",
      label: "native-takeover",
      probe: false,
      settings: {
        shutdownTimeout: 10000,
        recovery: { maxRestarts: 0, windowMs: 60000, baseDelayMs: 50, maxDelayMs: 100 },
        pluginSandbox: {
          native: {
            plugins: [
              {
                id: pluginId,
                timeoutMs: 15000,
                network: "none",
                writablePaths: ["data/native-takeover"],
                writableFiles: ["config/native-takeover.json"],
              },
            ],
          },
        },
      },
    })
    t.diagnostic(`Evidence: ${fixture.runRoot}`)
    const businessDir = path.join(fixture.root, "plugins", pluginId)
    const driverDir = path.join(fixture.root, "plugins/native-takeover-driver")
    fs.mkdirSync(businessDir)
    fs.mkdirSync(driverDir)
    fs.writeFileSync(path.join(businessDir, "index.js"), businessSource)
    fs.writeFileSync(path.join(driverDir, "index.js"), driverSource)
    const dataDir = path.join(fixture.root, "data/native-takeover")
    const statePath = path.join(dataDir, "state.json")
    const configPath = path.join(fixture.root, "config/native-takeover.json")
    fs.mkdirSync(dataDir)
    fs.writeFileSync(statePath, JSON.stringify({ seed: "original-business-data", starts: 0 }))
    fs.writeFileSync(configPath, JSON.stringify({ seed: "original-business-config", starts: 0 }))
    const expectedHashes = Object.fromEntries(
      [path.join(businessDir, "index.js"), path.join(driverDir, "index.js")].map(file => [
        path.relative(fixture.root, file),
        digest(file),
      ]),
    )
    const logPath = path.join(fixture.runRoot, "native-takeover.log")
    const report = {
      platform: process.platform,
      node: process.version,
      entry: "original node app.js without NODE_OPTIONS",
      isolationMode: "managed core with one explicitly selected native OS sandbox",
      startupBlindSpot:
        "Code may run in the original core before Guard init. This test records that generation and does not claim preload protection for it; isolation assertions apply after bootstrap-exit-confirmed.",
      scope:
        "Generated benign business plugin and trusted driver only; no third-party ecosystem claim",
      redis: fixture.redisFixture,
      sourceHashesBefore: expectedHashes,
      generations: [],
      status: "pending",
    }
    const observed = []
    let bootstrap,
      uninstalled,
      failure,
      stopped = false
    const start = extra => {
      const log = fs.openSync(logPath, "a")
      const child = spawn(process.execPath, [path.join(fixture.root, "app.js")], {
        cwd: fixture.root,
        env: environment(extra),
        stdio: ["ignore", log, log],
        windowsHide: true,
      })
      fs.closeSync(log)
      child.on("error", () => {})
      return child
    }
    const audits = (generation, operation) =>
      fixture
        .events()
        .filter(
          row =>
            row.generation === generation &&
            row.event?.plugin === pluginId &&
            row.event?.operation === operation,
        )
    const inspectGeneration = async status => {
      const driver = await until(
        () =>
          readJson(
            path.join(fixture.root, `data/native-takeover-driver-${status.generation}.json`),
          ),
        "Controlled business command did not complete",
      )
      assert.equal(driver.error, undefined, JSON.stringify(driver))
      assert.equal(driver.corePid, status.workerPid)
      assert.equal(driver.replies.length, 1)
      const reply = driver.replies[0]
      assert.equal(reply.kind, "native-takeover")
      assert.equal(reply.seed, "original-business-data")
      assert.equal(reply.configSeed, "original-business-config")
      assert.equal(normalize(reply.statePath), normalize(statePath))
      assert.equal(normalize(reply.configPath), normalize(configPath))
      await until(
        () =>
          lines(path.join(businessDir, "tasks.jsonl")).some(
            row => row.pid === reply.pid && row.namespace === reply.namespace,
          ),
        "Native plugin timer did not run",
        5000,
      )
      const started = audits(status.generation, "native.process-started")
      assert.equal(
        started.length,
        1,
        "Exactly one native session must start per controlled generation",
      )
      assert.equal(
        started[0].event.target,
        process.platform === "win32" ? "appcontainer" : "bubblewrap",
      )
      assert.equal(started[0].event.runtime?.kind, "native-scope")
      assert.equal(started[0].event.runtime?.observability, "os-confined")
      assert.ok(
        Number.isSafeInteger(started[0].event.runtime?.pid),
        "Native scope PID must come from parent audit",
      )
      const scope = snapshot(status.hostPid)
      observed.push(...scope)
      const roles = ownedNodeRoles(fixture, scope, status)
      assert.deepEqual(roles.host, [status.hostPid])
      assert.deepEqual(roles.core, [status.workerPid])
      assert.equal(roles.native.length, 1, JSON.stringify(roles))
      assert.ok(scope.some(row => row.pid === started[0].event.runtime.pid))
      if (process.platform === "win32") assert.equal(roles.native[0], reply.pid)
      assert.equal(
        lines(path.join(businessDir, "imports.jsonl")).some(row => row.pid === status.workerPid),
        false,
        "Controlled host core must not import native business source",
      )
      const state = readJson(statePath)
      const config = readJson(configPath)
      assert.equal(state.starts, reply.starts)
      assert.equal(config.starts, reply.starts)
      const result = {
        generation: status.generation,
        hostPid: status.hostPid,
        corePid: status.workerPid,
        roles,
        scope,
        nativeAudit: started[0],
        business: reply,
        data: state,
        config,
      }
      report.generations.push(result)
      return result
    }
    try {
      bootstrap = start()
      observed.push(...snapshot(bootstrap.pid))
      const firstStatus = await fixture.waitOnline()
      assert.equal(firstStatus.generation, 1)
      await until(
        () => bootstrap.exitCode !== null || bootstrap.signalCode !== null,
        "Original node app.js did not exit after handoff",
        10000,
      )
      assert.equal(bootstrap.exitCode, 0)
      assert.notEqual(firstStatus.hostPid, bootstrap.pid)
      const handoff = fixture.events().filter(row => row.type === "bootstrap-exit-confirmed")
      assert.equal(handoff.length, 1)
      assert.equal(handoff[0].bootstrapPid, bootstrap.pid)
      const spawnEvent = fixture
        .events()
        .find(row => row.type === "worker-spawn" && row.generation === 1)
      assert.ok(
        spawnEvent.sequence > handoff[0].sequence,
        "Controlled core must start after original process exit confirmation",
      )
      report.bootstrap = { pid: bootstrap.pid, exitCode: bootstrap.exitCode, handoff }
      const first = await inspectGeneration(firstStatus)
      const oldCoreScope = snapshot(firstStatus.workerPid)
      assert.ok(oldCoreScope.length >= 2)
      report.cliRestart = fixture.cli("restart")
      const secondStatus = await fixture.waitOnline(firstStatus.generation + 1)
      assert.equal(secondStatus.generation, firstStatus.generation + 1)
      assert.equal(secondStatus.hostPid, firstStatus.hostPid)
      await waitScopeGone(oldCoreScope)
      const second = await inspectGeneration(secondStatus)
      assert.ok(second.business.starts > first.business.starts)
      assert.equal(audits(firstStatus.generation, "native.process-closed").length, 1)
      assert.ok(
        lines(path.join(businessDir, "cleanups.jsonl")).some(
          row => row.pid === first.business.pid && row.namespace === first.business.namespace,
        ),
      )
      assert.equal(
        new Set(
          fixture
            .events()
            .filter(row => row.type === "host-lock-acquired")
            .map(row => row.hostPid),
        ).size,
        1,
      )
      report.oldGenerationScopeGone = true
      Object.assign(report, await fixture.finish())
      stopped = true
      await waitScopeGone(observed)
      assert.equal(audits(secondStatus.generation, "native.process-closed").length, 1)
      assert.ok(
        lines(path.join(businessDir, "cleanups.jsonl")).some(
          row => row.pid === second.business.pid && row.namespace === second.business.namespace,
        ),
      )
      assert.equal(
        fixture.events().some(row => row.event?.operation === "native.cleanup-unconfirmed"),
        false,
      )
      const beforeRemoval = { state: readJson(statePath), config: readJson(configPath) }
      const guardDestination = path.join(fixture.runRoot, "removed-guard-plugin")
      assert.equal(fs.realpathSync.native(fixture.pluginDir), path.resolve(fixture.pluginDir))
      assert.equal(
        path.dirname(fs.realpathSync.native(fixture.pluginDir)),
        fs.realpathSync.native(path.join(fixture.root, "plugins")),
      )
      assert.equal(
        path.dirname(path.resolve(guardDestination)),
        fs.realpathSync.native(fixture.runRoot),
      )
      fs.renameSync(fixture.pluginDir, guardDestination)
      assert.deepEqual(readJson(statePath), beforeRemoval.state)
      assert.deepEqual(readJson(configPath), beforeRemoval.config)
      uninstalled = start({ GUARD_TAKEOVER_FIXTURE_UNINSTALLED: "1" })
      const uninstallScope = snapshot(uninstalled.pid)
      observed.push(...uninstallScope)
      const plain = await until(
        () => readJson(path.join(fixture.root, "data/native-takeover-driver-uninstalled.json")),
        "Original business plugin could not run after removing Guard",
        30000,
      )
      assert.equal(plain.error, undefined, JSON.stringify(plain))
      assert.equal(plain.generation, null)
      assert.equal(plain.corePid, uninstalled.pid)
      assert.equal(plain.replies.length, 1)
      assert.equal(plain.replies[0].pid, uninstalled.pid)
      assert.equal(plain.replies[0].seed, beforeRemoval.state.seed)
      assert.equal(plain.replies[0].configSeed, beforeRemoval.config.seed)
      assert.equal(plain.replies[0].starts, beforeRemoval.state.starts + 1)
      assert.equal(normalize(plain.replies[0].statePath), normalize(statePath))
      assert.equal(normalize(plain.replies[0].configPath), normalize(configPath))
      await until(
        () => uninstalled.exitCode !== null || uninstalled.signalCode !== null,
        "Plain core did not shut down after uninstall check",
        15000,
      )
      assert.equal(uninstalled.exitCode, 0)
      await waitScopeGone(uninstallScope)
      assert.equal(fs.existsSync(path.join(fixture.stateDir, "control.json")), false)
      report.uninstall = {
        originalPathsPreserved: true,
        beforeRemoval,
        plainBusiness: plain,
        exitCode: uninstalled.exitCode,
      }
      report.status = "passed"
    } catch (error) {
      failure = error
      report.status = "failed"
      report.failure = String(error.stack)
    } finally {
      try {
        if (!stopped) Object.assign(report, await fixture.finish())
        for (const child of [bootstrap, uninstalled])
          if (child && child.exitCode === null && child.signalCode === null) {
            const exit = new Promise(resolve => child.once("exit", resolve))
            child.kill()
            await exit
          }
        await waitScopeGone(observed)
        report.cleanup = true
      } catch (error) {
        failure ??= error
        report.cleanup = false
        report.cleanupError = String(error.stack)
        report.status = "failed"
      }
      report.sourceHashesAfter = Object.fromEntries(
        Object.keys(expectedHashes).map(file => [file, digest(path.join(fixture.root, file))]),
      )
      try {
        assert.deepEqual(report.sourceHashesAfter, expectedHashes)
        Object.assign(report, fixture.verifyCoreHashes())
        report.uncontrolledImports = lines(path.join(businessDir, "imports.jsonl")).filter(
          row => row.pid === bootstrap?.pid,
        )
        report.schedulerClean = !fs.readFileSync(logPath, "utf8").includes("独立沙箱已关闭")
        assert.equal(report.schedulerClean, true, "Scheduled task ran after native session close")
      } catch (error) {
        failure ??= error
        report.status = "failed"
        report.verificationError = String(error.stack)
      }
      fs.writeFileSync(
        path.join(fixture.runRoot, "native-takeover-report.json"),
        JSON.stringify(report, null, 2) + "\n",
      )
    }
    if (failure) throw failure
  },
)
