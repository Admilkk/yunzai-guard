import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { createEnvironmentFixture, snapshot, until, waitScopeGone } from "./environment-fixture.mjs"

const testsRoot = path.dirname(fileURLToPath(import.meta.url))
export const r29Budgets = Object.freeze({
  startupMs: 15000,
  handshakeMs: 5000,
  shutdownMs: 10000,
  onlineMs: 60000,
  businessReadyMs: 15000,
  hookMs: 5000,
  windowsStopMs: 60000,
  linuxStopMs: 30000,
  caseMs: 180000,
})
export const r29NodeDigests = Object.freeze({
  win32: "d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5",
  linux: "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108",
})
const coreManifestSha256 = "f737bd5b119fff7fe9e7e1fddc4ba5bb112d8e91ff7b3f14bf41d51fe4db5f3a"
const sha = bytes => createHash("sha256").update(bytes).digest("hex")
const fileHash = file => sha(fs.readFileSync(file))
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const plain = value => value && typeof value === "object" && !Array.isArray(value)
const safeRelative = value =>
  typeof value === "string" &&
  value &&
  !path.isAbsolute(value) &&
  !value.includes("\\") &&
  !value
    .split("/")
    .some(part => !part || [".", "..", "__proto__", "constructor", "prototype"].includes(part))
const testInputs = [
  "environment-r29-managed.test.mjs",
  "r29-lifecycle-fixture.mjs",
  "environment-fixture.mjs",
  "audit-reader.mjs",
]

/** 操作者提供不可变输入；该输入不能选择目标 PID 或执行操作。 */
export function validateR29Manifest(input, platform, mode) {
  assert.ok(plain(input) && input.schemaVersion === 1 && input.revision === "r29")
  assert.ok(["win32", "linux"].includes(platform) && input.platform === platform)
  assert.ok(["managed", "os-sandbox"].includes(mode) && input.mode === mode)
  assert.ok(
    !(platform === "win32" && mode === "os-sandbox"),
    "Windows AppContainer canonical runtime is not qualified by this managed fixture",
  )
  assert.ok(plain(input.node) && input.node.version === "24.22.1" && input.node.arch === "x64")
  assert.equal(input.node.sha256, r29NodeDigests[platform])
  assert.ok(path.isAbsolute(input.node.path))
  assert.equal(input.coreManifestSha256, coreManifestSha256)
  assert.deepEqual(
    input.budgets,
    r29Budgets,
    "Resource/audit budgets must be fixed before the batch",
  )
  assert.ok(plain(input.guard) && path.isAbsolute(input.guard.root) && plain(input.guard.files))
  const files = Object.entries(input.guard.files)
  assert.ok(files.length > 0 && files.length <= 10000)
  for (const [file, hash] of files)
    assert.ok(
      safeRelative(file) &&
        digest(hash) &&
        (file === "index.js" || file.startsWith("dist/") || file.startsWith("native/")),
    )
  for (const file of [
    "index.js",
    "dist/launcher.js",
    "dist/host/supervisor.js",
    "dist/worker-preload.js",
    "dist/runtime/index.js",
    "dist/runtime/broker.js",
    "dist/runtime/worker-monitor.js",
    "dist/runtime/worker-transport.js",
    "dist/audit/receiver.js",
    "dist/audit/sender.js",
    "dist/audit/protocol.js",
    "dist/audit/buffer.js",
    "dist/audit/sink.js",
    "native/windows/GuardSandbox.cs",
    "native/windows/CanonicalMetadata.cs",
  ])
    assert.ok(Object.hasOwn(input.guard.files, file), `Frozen product lacks ${file}`)
  assert.ok(plain(input.tests) && Object.keys(input.tests).length === testInputs.length)
  for (const file of testInputs) assert.ok(digest(input.tests[file]))
  if (platform === "win32") {
    assert.ok(
      Object.hasOwn(input.guard.files, "native/process-identity/manifest.json"),
      "Windows managed cleanup requires the final prebuilt held-native bundle",
    )
    assert.ok(
      Object.hasOwn(
        input.guard.files,
        "native/process-identity/bin/win32-x64/process-identity.exe",
      ),
    )
  }
  return input
}

function ordinary(root, relative) {
  let file = fs.realpathSync.native(root)
  for (const segment of relative.split("/")) {
    file = path.join(file, segment)
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false, `Frozen input is linked: ${relative}`)
  }
  const stat = fs.lstatSync(file)
  assert.ok(
    stat.isFile() && stat.nlink === 1,
    `Frozen input is not an ordinary single-link file: ${relative}`,
  )
  return file
}
function inventory(root, relative = "") {
  const result = []
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const file = relative ? `${relative}/${entry.name}` : entry.name
    assert.equal(entry.isSymbolicLink(), false, `Product contains linked input: ${file}`)
    if (entry.isDirectory()) result.push(...inventory(root, file))
    else {
      assert.ok(entry.isFile())
      result.push(file)
    }
    assert.ok(result.length <= 10000, "Frozen product inventory exceeded its bound")
  }
  return result
}
export function verifyR29Product(input, root = input.guard.root) {
  const actualFiles = ["index.js", ...inventory(root, "dist"), ...inventory(root, "native")].sort()
  assert.deepEqual(
    actualFiles,
    Object.keys(input.guard.files).sort(),
    "Frozen product file set changed",
  )
  for (const [file, hash] of Object.entries(input.guard.files))
    assert.equal(fileHash(ordinary(root, file)), hash, `Product changed: ${file}`)
}
/** 核对 Host 每个代次和阶段的全部平面记录，包括已退役来源的汇总。 */
export function readR29Coverage(records, stage, generation) {
  const rows = records.filter(row => row.generation === generation && row.stage === stage)
  const summaries = rows.filter(row => row.type === "audit-coverage-summary")
  const retired = rows.filter(row => row.type === "audit-retired-summary")
  const sources = rows.filter(row => row.type === "audit-source-summary")
  assert.equal(summaries.length, 1, `Missing/duplicate ${stage} coverage declaration`)
  assert.equal(retired.length, 1, `Missing/duplicate ${stage} retired aggregate`)
  const summary = summaries[0]
  assert.equal(summary.retiredDetail, "aggregate-only")
  assert.equal(
    summary.activeSources,
    sources.length,
    "Active source records do not match their declaration",
  )
  assert.equal(
    summary.retiredSources,
    retired[0].sources,
    "Retired aggregate does not match its declaration",
  )
  const ids = new Set()
  for (const source of sources) {
    assert.ok(
      Number.isSafeInteger(source.sourceId) && source.sourceId > 0 && !ids.has(source.sourceId),
      "Missing/duplicate Host source identity",
    )
    ids.add(source.sourceId)
    assert.equal(source.transportCounterUnit, "channel-incidents-not-records")
    for (const key of [
      "received",
      "receivedThrough",
      "written",
      "rejected",
      "unknown",
      "sourceUnknown",
      "sourceRejected",
      "sourceCoalesced",
      "sourcePendingRecords",
      "transportUnknown",
      "pending",
    ])
      assert.ok(
        Number.isSafeInteger(source[key]) && source[key] >= 0,
        `Invalid source counter ${key}`,
      )
    assert.ok(["all-offered-written", "settled-with-loss", "incomplete"].includes(source.outcome))
    if (source.outcome === "all-offered-written") {
      for (const key of [
        "unknown",
        "rejected",
        "sourceUnknown",
        "sourceRejected",
        "sourceCoalesced",
        "sourcePendingRecords",
        "transportUnknown",
        "pending",
      ])
        assert.equal(source[key], 0)
      assert.equal(source.sealed, true)
      assert.equal(source.nestedCoverage, "settled")
      assert.equal(source.evidence, "host-append-completed")
    }
  }
  return { summary, retired: retired[0], sources }
}
export function readR29Inputs({ file, inputSha256, platform, mode }) {
  assert.ok(
    path.isAbsolute(file) && digest(inputSha256),
    "An absolute final input manifest and exact SHA256 are required",
  )
  const stat = fs.lstatSync(file)
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 4 * 1024 * 1024,
  )
  const bytes = fs.readFileSync(file)
  assert.equal(sha(bytes), inputSha256, "Final R29 input SHA mismatch")
  const input = validateR29Manifest(JSON.parse(bytes.toString("utf8")), platform, mode)
  assert.equal(process.arch, "x64")
  assert.equal(process.versions.node, input.node.version)
  assert.equal(
    fs.realpathSync.native(process.execPath).toLowerCase(),
    fs.realpathSync.native(input.node.path).toLowerCase(),
  )
  assert.equal(fileHash(process.execPath), input.node.sha256)
  for (const key of Object.keys(process.env))
    assert.ok(
      !["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE"].includes(key.toUpperCase()),
      `Injected runtime environment is present: ${key}`,
    )
  assert.equal(fileHash(path.join(testsRoot, "core-manifest.json")), input.coreManifestSha256)
  assert.equal(
    Object.keys(JSON.parse(fs.readFileSync(path.join(testsRoot, "core-manifest.json"), "utf8")))
      .length,
    47,
  )
  for (const file of testInputs)
    assert.equal(
      fileHash(path.join(testsRoot, file)),
      input.tests[file],
      `Test input changed: ${file}`,
    )
  verifyR29Product(input)
  if (platform === "win32") {
    const nativeRoot = path.join(input.guard.root, "native/process-identity")
    const manifest = JSON.parse(fs.readFileSync(ordinary(nativeRoot, "manifest.json"), "utf8"))
    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.protocol, 1)
    assert.equal(manifest.profileSet, "node24.22.1-v1")
    for (const [name, hash] of Object.entries(manifest.sources)) {
      assert.ok(safeRelative(name))
      assert.equal(fileHash(ordinary(nativeRoot, name)), hash)
    }
    const artifacts = manifest.artifacts.filter(
      item => item.platform === "win32" && item.architecture === "x64",
    )
    assert.equal(artifacts.length, 1)
    const artifact = artifacts[0]
    assert.equal(artifact.file, "bin/win32-x64/process-identity.exe")
    assert.equal(artifact.format, "pe-framework")
    assert.equal(fileHash(ordinary(nativeRoot, artifact.file)), artifact.sha256)
    assert.equal(fs.statSync(path.join(nativeRoot, artifact.file)).size, artifact.bytes)
  }
  return input
}

export const r29ProbeSources = Object.freeze({
  "index.js": `import fs from "node:fs"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { spawn } from "node:child_process"
await Promise.resolve()
const root = process.cwd(), marker = path.join(root,"data/r29-lifecycle.jsonl")
const mark = event => fs.appendFileSync(marker,JSON.stringify({event,pid:process.pid})+"\\n")
export class R29Probe extends plugin {
  constructor(){super({name:"R29 default lifecycle fixture",rule:[]})}
  init(){
    if(!globalThis[Symbol.for("yunzai.guard.context.v1")])return
    Bot.once("online",()=>setTimeout(()=>{
      for(const type of ["restart-request","stop-request","preload-ready","worker-online"])
        process.send({type,generation:1,pid:process.pid,sequence:999,signature:"0".repeat(64)})
      try{fs.readFileSync(path.join(root,"data/yunzai-guard/control.json"));mark("control-read-allowed")}
      catch(error){mark(error.code==="ERR_GUARD_SELF_PROTECTION"?"control-read-denied":"control-read-unexpected")}
      mark("forged-controls-sent")
      let workerReady=false,childReady=false
      const ready=()=>{if(workerReady&&childReady)mark("business-ready")}
      const worker=new Worker(new URL("./worker.mjs",import.meta.url))
      const child=spawn(process.execPath,[path.join(root,"plugins/r29-lifecycle-probe/child.mjs")],{stdio:["ignore","pipe","pipe","ipc"]})
      child.stdout.resume();child.stderr.resume()
      worker.on("error",()=>mark("worker-error"));child.on("error",()=>mark("child-error"))
      worker.once("message",()=>{workerReady=true;ready()});child.once("message",()=>{childReady=true;ready()})
      const owner=Bot.bot??Bot,old=Bot.em
      const wrapped=function(...args){mark("hook-called");return Reflect.apply(old,this,args)}
      owner.em=wrapped
      Bot.em("guard.r29.fixture",{})
      const closed=(target,label)=>new Promise((resolve,reject)=>{target.once("exit",code=>{mark(label+"-native-exit-"+code);code===0?resolve():reject(new Error(label+" exit "+code))})})
      const workerExit=closed(worker,"worker"),childExit=closed(child,"child")
      Bot.once("exit",async()=>{
        mark("core-exit-hook")
        if(owner.em===wrapped)owner.em=old
        worker.postMessage("normal-stop");child.send("normal-stop")
        let timer
        try{await Promise.race([Promise.all([workerExit,childExit]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("R29 business exit deadline")),3000)})]);mark("business-cleanup-complete")}
        finally{clearTimeout(timer)}
      })
      const poll=setInterval(()=>{if(fs.existsSync(path.join(root,"data/r29-exit.request"))){clearInterval(poll);mark("bot-exit-request");void Bot.exit()}},25)
    },120))
  }
}
`,
  "worker.mjs": `import fs from "node:fs";import path from "node:path";import {parentPort} from "node:worker_threads"
await Promise.resolve()
const mark=event=>fs.appendFileSync(path.resolve("data/r29-lifecycle.jsonl"),JSON.stringify({event,pid:process.pid})+"\\n")
mark("worker-effect");parentPort.postMessage("ready")
parentPort.once("message",()=>{mark("worker-exit-effect");parentPort.close()})
`,
  "child.mjs": `import fs from "node:fs";import path from "node:path"
await Promise.resolve()
const mark=event=>fs.appendFileSync(path.resolve("data/r29-lifecycle.jsonl"),JSON.stringify({event,pid:process.pid})+"\\n")
mark("child-effect");process.send("ready")
process.once("message",()=>{mark("child-exit-effect");process.disconnect()})
`,
})

export async function createR29LifecycleFixture(input) {
  const fixture = await createEnvironmentFixture({
    mode: input.mode,
    label: `r29-minimal-${input.mode}`,
    probe: false,
    guardSource: input.guard.root,
  })
  const configuration = {
    controlPort: fixture.settings.controlPort,
    ...(input.mode === "os-sandbox"
      ? { isolationMode: "os-sandbox", sandbox: { network: "none" } }
      : {}),
  }
  fs.writeFileSync(
    path.join(fixture.stateDir, "settings.json"),
    JSON.stringify(configuration, null, 2) + "\n",
  )
  const plugin = path.join(fixture.root, "plugins/r29-lifecycle-probe")
  fs.mkdirSync(plugin, { recursive: true })
  for (const [name, source] of Object.entries(r29ProbeSources))
    fs.writeFileSync(path.join(plugin, name), source)
  const sentinel = path.join(fixture.root, "data/existing-business-data.txt"),
    sentinelBytes = Buffer.from("existing-business-data-must-remain\n")
  fs.writeFileSync(sentinel, sentinelBytes)
  const markers = () =>
    fs.existsSync(path.join(fixture.root, "data/r29-lifecycle.jsonl"))
      ? fs
          .readFileSync(path.join(fixture.root, "data/r29-lifecycle.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map(line => JSON.parse(line))
      : []
  const reportFile = path.join(fixture.runRoot, "r29-report.json")
  const report = {
    schemaVersion: 1,
    platform: process.platform,
    mode: input.mode,
    budgets: r29Budgets,
    nodeSha256: input.node.sha256,
    status: "prepared-not-run",
    checks: [],
    errors: [],
    limitations: [
      "Scoped append/hop receipts are not durable or exhaustive syscall evidence",
      "Windows full-business outer-AppContainer/inner-private-Node held-native census/profile compatibility remains unqualified; this fixture puts the Guard Host outside AppContainer",
      "Linux os-sandbox requires unchanged host user-namespace/bwrap capabilities and trusted FD5 init-exit proof; no permission relaxation is allowed",
    ],
  }
  const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n")
  save()
  return {
    ...fixture,
    input,
    markers,
    report,
    save,
    reportFile,
    verify: () => {
      verifyR29Product(input)
      verifyR29Product(input, fixture.pluginDir)
      fixture.verifyCoreHashes()
      assert.deepEqual(fs.readFileSync(sentinel), sentinelBytes)
    },
    triggerBotExit: () =>
      fs.writeFileSync(path.join(fixture.root, "data/r29-exit.request"), "normal Bot.exit\n"),
    snapshot,
    waitScopeGone,
    until,
  }
}
