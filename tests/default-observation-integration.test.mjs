import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { performance } from "node:perf_hooks"
import test from "node:test"
import { createEnvironmentFixture, snapshot, until, waitScopeGone } from "./environment-fixture.mjs"
import { ownedProcessRows } from "./helpers/process-ownership.mjs"

const enabled =
  process.env.GUARD_TEST_DEFAULT_OBSERVATION === "1" &&
  ["win32", "linux"].includes(process.platform)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
const fileHash = file => hash(fs.readFileSync(file))
const readJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return undefined
    throw error
  }
}

function frozenGuard() {
  const supplied = process.env.GUARD_TEST_GUARD_SOURCE
  assert.ok(
    supplied && path.isAbsolute(supplied),
    "Set GUARD_TEST_GUARD_SOURCE to the frozen Guard directory",
  )
  const directory = fs.realpathSync.native(supplied)
  const manifestFile = path.join(path.dirname(directory), "guard-build.json")
  const bytes = fs.readFileSync(manifestFile)
  const manifest = JSON.parse(bytes)
  const files = manifest.files ?? manifest
  for (const [file, expected] of Object.entries(files)) {
    assert.ok(!path.isAbsolute(file) && !file.split(/[\\/]/).includes(".."))
    assert.match(expected, /^[0-9a-f]{64}$/)
    assert.equal(fileHash(path.join(directory, file)), expected, `Frozen Guard changed: ${file}`)
  }
  return { directory, manifestFile, manifestSha256: hash(bytes), files }
}

const commandSource = `const fs=require("node:fs")
fs.writeFileSync(process.argv[3],"effect:"+process.argv[2])
process.stdout.write(process.argv[2])
`
const workerSource = `import {parentPort,workerData,threadId} from "node:worker_threads"
parentPort.once("message",message=>{
  parentPort.postMessage({kind:"application-worker-reply",message,workerData,threadId,pid:process.pid})
  parentPort.close()
})
`
const forkSource = `process.once("message",message=>{
  process.send({kind:"application-fork-reply",message,pid:process.pid},()=>process.disconnect())
})
`

function businessSource(id, { ordinary = false, restart = false } = {}) {
  return `import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {execFileSync,spawnSync,fork} from "node:child_process"
import {Worker} from "node:worker_threads"
const own=path.dirname(fileURLToPath(import.meta.url))
const put=(name,value)=>fs.writeFileSync(path.join(own,name),JSON.stringify(value))
const identity=${JSON.stringify(id)}
const run=operation=>{
  try{
    const marker=path.join(own,operation+"-side-effect.txt")
    const args=[fileURLToPath(new URL("./command.cjs",import.meta.url)),operation,marker]
    const options={encoding:"utf8",windowsHide:true,timeout:10000}
    const value=operation==="execFileSync"?execFileSync(process.execPath,args,options):spawnSync(process.execPath,args,options)
    return {allowed:true,value:typeof value==="string"?value:value.stdout,status:typeof value==="string"?0:value.status}
  }catch(error){return {allowed:false,code:error.code,operation:error.operation,ruleId:error.ruleId,message:error.message}}
}
const exchange=async(child,request)=>{
  const messages=[]
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("Application IPC timeout")),15000)
    child.on("error",error=>{clearTimeout(timer);reject(error)})
    child.on("message",value=>messages.push(value))
    child.once("exit",code=>{clearTimeout(timer);code===0?resolve({messages,code}):reject(new Error("Application child exit "+code))})
    if(child.postMessage)child.postMessage(request)
    else child.send(request)
  })
  return result
}
export class OriginalApiBusiness extends plugin {
  constructor(){super({name:identity,rule:[]})}
  async init(){
    const context=globalThis[Symbol.for("yunzai.guard.context.v1")]
    const result={pid:process.pid,id:identity,generation:context?.generation,
      effectiveDefaults:{protectAction:context?.settings.protect.action,rules:context?.settings.rules,native:context?.settings.pluginSandbox.native.plugins},
      legacyData:JSON.parse(fs.readFileSync("data/legacy-observation/state.json","utf8")),
      legacyConfig:JSON.parse(fs.readFileSync("config/legacy-observation.json","utf8"))}
    try{
      ${
        restart
          ? `
      if(context.generation===1){
        const attempted={generation:context.generation,pid:process.pid,type:"audit",event:{kind:"process",operation:"execFileSync",target:process.execPath,plugin:identity,action:"audit"}}
        put("restart-attempt.json",attempted)
        context.send(attempted.type,{event:attempted.event})
      }else result.restartHandled=true
      `
          : `result.execFileSync=run("execFileSync")`
      }
      ${
        restart
          ? ""
          : ordinary
            ? `
      const owner=Bot.bot??Bot
      const original=Bot.em
      let calls=0
      const wrapped=function(...args){calls++;return Reflect.apply(original,this,args)}
      owner.em=wrapped
      const restore=()=>{if(owner.em===wrapped)owner.em=original;put("cleanup.json",{restored:Bot.em===original,calls,pid:process.pid})}
      this.addCleanup(restore)
      Bot.once("exit",restore)
      result.hookInstalled=Bot.em===wrapped
      Bot.em("guard-default-observation.fixture",{source:identity})
      result.hookCalls=calls
      const worker=new Worker(new URL("./worker.mjs",import.meta.url),{workerData:{original:"worker-data"}})
      result.worker=await exchange(worker,{original:"worker-request"})
      const child=fork(new URL("./fork.cjs",import.meta.url),[],{windowsHide:true,stdio:["ignore","ignore","ignore","ipc"]})
      result.fork=await exchange(child,{original:"fork-request"})
      `
            : `result.spawnSync=run("spawnSync")`
      }
    }catch(error){result.error=String(error.stack)}
    put("result.json",result)
  }
}
`
}

async function runCase(t, { label, ids, rules, ordinary, restart = false }) {
  const frozen = frozenGuard()
  const fixture = await createEnvironmentFixture({
    mode: "managed",
    label,
    probe: false,
    guardSource: frozen.directory,
    settings: { shutdownTimeout: 10000, ...(rules === undefined ? {} : { rules }) },
  })
  t.diagnostic(`Evidence: ${fixture.runRoot}`)
  const rawSettings = readJson(path.join(fixture.stateDir, "settings.json"))
  assert.equal(
    Object.hasOwn(rawSettings, "protect"),
    false,
    "Do not override the default hook action",
  )
  assert.equal(
    Object.hasOwn(rawSettings, "pluginSandbox"),
    false,
    "Do not select native or VM plugins",
  )
  if (!rules) assert.equal(Object.hasOwn(rawSettings, "rules"), false)
  const { parseSettings } = await import(
    pathToFileURL(path.join(frozen.directory, "dist/config/index.js")).href
  )
  const parsed = parseSettings(rawSettings)
  assert.equal(parsed.protect.action, "audit")
  assert.deepEqual(parsed.pluginSandbox.plugins, [])
  assert.deepEqual(parsed.pluginSandbox.native.plugins, [])
  if (!rules) assert.deepEqual(parsed.rules, [])
  const codeHashes = {},
    dataHashes = {}
  const originalData = { original: "state-stays-at-original-path", counter: 7 }
  const originalConfig = { original: "config-stays-at-original-path", enabled: true }
  for (const [relative, value] of Object.entries({
    "data/legacy-observation/state.json": originalData,
    "config/legacy-observation.json": originalConfig,
  })) {
    const file = path.join(fixture.root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value) + "\n")
    dataHashes[relative] = fileHash(file)
  }
  for (const id of ids) {
    const directory = path.join(fixture.root, "plugins", id)
    fs.mkdirSync(directory)
    for (const [name, source] of Object.entries({
      "index.js": businessSource(id, { ordinary, restart }),
      "command.cjs": commandSource,
      ...(ordinary ? { "worker.mjs": workerSource, "fork.cjs": forkSource } : {}),
    })) {
      const file = path.join(directory, name)
      fs.writeFileSync(file, source)
      assert.equal(
        spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true })
          .status,
        0,
      )
      codeHashes[path.relative(fixture.root, file)] = fileHash(file)
    }
  }
  for (const [file, expected] of Object.entries(frozen.files))
    assert.equal(fileHash(path.join(fixture.pluginDir, file)), expected)
  const output = fs.openSync(path.join(fixture.runRoot, "default-observation.log"), "w")
  const environment = { ...process.env, NODE_OPTIONS: "" }
  for (const key of [
    "pm_id",
    "PM2_HOME",
    "NODE_APP_INSTANCE",
    "YUNZAI_GUARD_PIPE",
    "YUNZAI_GUARD_RUNTIME_MANIFEST",
    "YUNZAI_GUARD_MANAGED",
    "YUNZAI_GUARD_SANDBOX",
  ])
    delete environment[key]
  const child = spawn(process.execPath, [fixture.launcher], {
    cwd: fixture.root,
    env: environment,
    windowsHide: true,
    stdio: ["ignore", output, output],
  })
  fs.closeSync(output)
  const report = {
    schemaVersion: 1,
    testSourceSha256: hash(fs.readFileSync(new URL(import.meta.url))),
    platform: process.platform,
    node: process.version,
    mode: "managed",
    guardBuildManifest: frozen.manifestFile,
    guardBuildManifestSha256: frozen.manifestSha256,
    rawSettingsKeys: Object.keys(rawSettings),
    defaultProtectOverride: false,
    defaultNativeSelectionOverride: false,
    rules: rules ?? [],
    sourceHashesBefore: codeHashes,
    originalDataHashesBefore: dataHashes,
    redis: fixture.redisFixture,
    coverage:
      "Generated original API plugins through the real core; no full ecosystem or hostile-code isolation claim",
  }
  const observed = new Map()
  const capture = hostPid => {
    const rows = snapshot(hostPid)
    const owner = rows.find(row => row.pid === hostPid)
    if (!owner) return
    for (const row of ownedProcessRows(rows, [owner])) observed.set(`${row.pid}:${row.start}`, row)
  }
  let failure
  try {
    const expectedGeneration = restart ? 2 : 1
    const online = await fixture.waitOnline(expectedGeneration)
    report.initialGeneration = online.generation
    capture(online.hostPid)
    assert.equal(online.generation, expectedGeneration)
    report.results = {}
    for (const id of ids) {
      const result = await until(() => {
        const value = readJson(path.join(fixture.root, "plugins", id, "result.json"))
        return value?.generation === expectedGeneration ? value : false
      }, `${id} did not finish original API operations`)
      report.results[id] = result
      assert.equal(result.error, undefined)
      assert.equal(
        result.pid,
        online.workerPid,
        "Default compatibility should execute in the original core",
      )
      assert.equal(result.generation, expectedGeneration)
      assert.equal(result.effectiveDefaults.protectAction, "audit")
      assert.deepEqual(result.effectiveDefaults.native, [])
      assert.deepEqual(result.legacyData, originalData)
      assert.deepEqual(result.legacyConfig, originalConfig)
      if (restart) {
        assert.equal(result.restartHandled, true)
        report.restartAttempt = readJson(
          path.join(fixture.root, "plugins", id, "restart-attempt.json"),
        )
        assert.equal(report.restartAttempt?.generation, 1)
        assert.equal(report.restartAttempt?.type, "audit")
        assert.equal(report.restartAttempt?.event.action, "audit")
        assert.notEqual(report.restartAttempt?.pid, online.workerPid)
        assert.equal(
          fs.existsSync(path.join(fixture.root, "plugins", id, "execFileSync-side-effect.txt")),
          false,
        )
      } else if (ordinary) {
        assert.deepEqual(result.effectiveDefaults.rules, [])
        assert.equal(result.execFileSync.allowed, true)
        assert.equal(result.execFileSync.value, "execFileSync")
        assert.equal(result.hookInstalled, true)
        assert.ok(result.hookCalls >= 1)
        assert.equal(result.worker.code, 0)
        assert.equal(result.worker.messages.length, 1)
        assert.equal(result.worker.messages[0].kind, "application-worker-reply")
        assert.deepEqual(result.worker.messages[0].message, { original: "worker-request" })
        assert.deepEqual(result.worker.messages[0].workerData, { original: "worker-data" })
        assert.equal(result.fork.code, 0)
        assert.equal(result.fork.messages.length, 1)
        assert.equal(result.fork.messages[0].kind, "application-fork-reply")
        assert.deepEqual(result.fork.messages[0].message, { original: "fork-request" })
      } else {
        assert.equal(result.execFileSync.allowed, id === "observe-peer")
        if (id === "observe-peer") assert.equal(result.execFileSync.value, "execFileSync")
        if (id !== "observe-peer") {
          assert.equal(result.execFileSync.code, "GUARD_DENIED")
          assert.equal(result.execFileSync.ruleId, "one-plugin-exec")
          assert.equal(
            fs.existsSync(path.join(fixture.root, "plugins", id, "execFileSync-side-effect.txt")),
            false,
          )
        }
        assert.equal(result.spawnSync.allowed, false)
        assert.equal(result.spawnSync.code, "GUARD_DENIED")
        assert.equal(result.spawnSync.ruleId, "global-spawn")
        assert.equal(
          fs.existsSync(path.join(fixture.root, "plugins", id, "spawnSync-side-effect.txt")),
          false,
        )
      }
    }
    const observedAt = performance.now()
    const observationMs = Math.max(3500, parsed.protect.intervalMs * 3 + 250)
    const generations = []
    while (performance.now() - observedAt < observationMs) {
      const current = await fixture.status()
      capture(current.hostPid)
      generations.push(current.generation)
      assert.equal(current.phase, "online")
      assert.equal(current.generation, expectedGeneration)
      await pause(250)
    }
    const events = fixture.events()
    const audits = events.filter(row => row.type === "audit").map(row => row.event)
    report.observation = { elapsedMs: performance.now() - observedAt, generations }
    report.auditEvidence = audits
    const violations = events.filter(row => row.type === "violation")
    report.violationEvidence = violations
    assert.equal(violations.length, restart ? 1 : 0)
    assert.equal(
      audits.some(event => event.operation === "native.process-started"),
      false,
    )
    if (restart) {
      assert.equal(violations[0].generation, 1)
      assert.equal(violations[0].event.plugin, ids[0])
      assert.equal(violations[0].event.operation, "execFileSync")
      assert.equal(violations[0].event.ruleId, "audit-channel-restart")
      assert.equal(violations[0].event.action, "restart")
      const failureEvents = events.filter(row => row.type === "recovery-scheduled")
      report.recoveryEvidence = failureEvents
      assert.equal(failureEvents.length, 1)
      assert.equal(failureEvents[0].reason, "policy-violation:audit-channel-restart")
    } else if (ordinary) {
      for (const operation of ["execFileSync", "worker", "fork"])
        assert.ok(
          audits.some(
            event =>
              event.kind === "process" &&
              event.operation === operation &&
              event.plugin === ids[0] &&
              event.action === "audit",
          ),
          `Missing default audit for ${operation}`,
        )
      assert.ok(
        audits.some(
          event =>
            event.kind === "integrity" && event.target === "Bot.em" && event.action === "audit",
        ),
        "The harmless original Bot.em wrapper was not recorded",
      )
      assert.equal(
        audits.some(event => event.action === "deny" || event.action === "restart"),
        false,
      )
    } else {
      assert.ok(
        audits.some(
          event =>
            event.plugin === "observe-one" &&
            event.ruleId === "one-plugin-exec" &&
            event.action === "deny",
        ),
      )
      assert.ok(
        audits.some(
          event =>
            event.plugin === "observe-peer" &&
            event.operation === "execFileSync" &&
            event.action === "audit",
        ),
      )
      for (const id of ids)
        assert.ok(
          audits.some(
            event =>
              event.plugin === id && event.ruleId === "global-spawn" && event.action === "deny",
          ),
        )
    }
    report.status = "passed"
  } catch (error) {
    failure = error
    report.status = "failed"
    report.error = String(error.stack)
  } finally {
    try {
      report.observedProcessIdentities = [...observed.values()]
      Object.assign(report, await fixture.finish())
      await waitScopeGone(report.observedProcessIdentities)
      await until(
        () => child.exitCode !== null || child.signalCode !== null,
        "The generated observation core did not stop",
        15000,
      )
      report.cleanup = {
        confirmed: true,
        launcherExitCode: child.exitCode,
        activeOwnershipRecords: fs
          .readdirSync(fixture.stateDir)
          .filter(name => /^windows-sandbox.*-active\.json$/.test(name)),
      }
      assert.equal(child.exitCode, 0, "The observation core must stop without an ordinary crash")
      assert.deepEqual(report.cleanup.activeOwnershipRecords, [])
      if (ordinary)
        assert.equal(
          readJson(path.join(fixture.root, "plugins", ids[0], "cleanup.json"))?.restored,
          true,
        )
    } catch (error) {
      failure ??= error
      report.status = "failed"
      report.cleanupError = String(error.stack)
    }
    try {
      report.sourceHashesAfter = Object.fromEntries(
        Object.keys(codeHashes).map(file => [file, fileHash(path.join(fixture.root, file))]),
      )
      report.originalDataHashesAfter = Object.fromEntries(
        Object.keys(dataHashes).map(file => [file, fileHash(path.join(fixture.root, file))]),
      )
      assert.deepEqual(report.sourceHashesAfter, codeHashes)
      assert.deepEqual(report.originalDataHashesAfter, dataHashes)
      for (const [file, expected] of Object.entries(frozen.files)) {
        assert.equal(fileHash(path.join(frozen.directory, file)), expected)
        assert.equal(fileHash(path.join(fixture.pluginDir, file)), expected)
      }
    } catch (error) {
      failure ??= error
      report.status = "failed"
      report.integrityError = String(error.stack)
    }
    fs.writeFileSync(
      path.join(fixture.runRoot, "default-observation-report.json"),
      JSON.stringify(report, null, 2) + "\n",
    )
  }
  if (failure) throw failure
}

test(
  "default managed observation preserves original exec, Worker, fork IPC and a harmless Bot.em wrapper",
  {
    skip: enabled
      ? false
      : "requires GUARD_TEST_DEFAULT_OBSERVATION=1 and an explicit frozen Guard build",
    timeout: 180000,
  },
  async t => runCase(t, { label: "default-observation", ids: ["observe-default"], ordinary: true }),
)

test(
  "manual restart rules remain authoritative when a matching event arrives on the audit channel",
  {
    skip: enabled
      ? false
      : "requires GUARD_TEST_DEFAULT_OBSERVATION=1 and an explicit frozen Guard build",
    timeout: 180000,
  },
  async t =>
    runCase(t, {
      label: "manual-observation-restart",
      ids: ["observe-restart"],
      ordinary: false,
      restart: true,
      rules: [
        {
          id: "audit-channel-restart",
          kind: "process",
          plugin: "observe-restart",
          operation: "execFileSync",
          action: "restart",
        },
      ],
    }),
)

test(
  "manual plugin and global rules deny only their selected operations while caught denials preserve the core",
  {
    skip: enabled
      ? false
      : "requires GUARD_TEST_DEFAULT_OBSERVATION=1 and an explicit frozen Guard build",
    timeout: 180000,
  },
  async t =>
    runCase(t, {
      label: "manual-observation-rules",
      ids: ["observe-one", "observe-peer"],
      ordinary: false,
      rules: [
        {
          id: "one-plugin-exec",
          kind: "process",
          plugin: "observe-one",
          operation: "execFileSync",
          action: "deny",
        },
        { id: "global-spawn", kind: "process", operation: "spawnSync", action: "deny" },
      ],
    }),
)
