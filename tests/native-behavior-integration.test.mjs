import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { performance } from "node:perf_hooks"
import test from "node:test"
import { createEnvironmentFixture } from "./environment-fixture.mjs"

const enabled =
  process.env.GUARD_TEST_NATIVE_BEHAVIOR === "1" && ["win32", "linux"].includes(process.platform)
const observerId = "native-behavior-observer",
  offenderId = "native-behavior-offender"
const ids = [observerId, offenderId]
const guardSource = process.env.GUARD_TEST_NATIVE_BEHAVIOR_SOURCE
const ipcOnlyDiagnostic = process.env.GUARD_TEST_NATIVE_BEHAVIOR_FORK_STDIO === "ipc-only"
const forkStdio = ipcOnlyDiagnostic ? 'stdio:["ignore","ignore","ignore","ipc"]' : "silent:true"
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha = value => createHash("sha256").update(value).digest("hex")
const readJson = file => {
  if (!fs.existsSync(file)) return undefined
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}
async function waitFor(predicate, description, timeout = 90000) {
  const deadline = performance.now() + timeout
  while (performance.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await pause(40)
  }
  throw new Error(description)
}

const probeSource = `import fs from "node:fs"
import path from "node:path"
import {createRequire} from "node:module"
import esm,{location} from "guard-behavior-esm"
const cjs=createRequire(import.meta.url)("guard-behavior-cjs")
export function probe(own,root,outside,label){
  fs.writeFileSync(path.join(own,label+"-own.txt"),"own plugin write")
  const attempt=file=>{try{fs.appendFileSync(file,"unexpected outside write");return {blocked:false}}catch(error){return {blocked:true,code:error.code}}}
  const visible=file=>{try{return fs.readFileSync(file,"utf8")}catch{return null}}
  const namespaceBefore=visible(outside),outsideWrite=attempt(outside),namespaceAfter=visible(outside)
  return {label,pid:process.pid,namespace:process.platform==="linux"?fs.readlinkSync("/proc/self/ns/pid"):null,
    runtime:Boolean(globalThis[Symbol.for("yunzai.guard.runtime.v1")]),
    alias:{esm,cjs,location,preload:globalThis.behaviorPreload??null},
    writes:{own:true,core:attempt(path.join(root,"app.js")),peer:attempt(path.join(root,"plugins",${JSON.stringify(offenderId)},"forbidden-peer.txt")),dependency:attempt(path.join(root,"node_modules/.pnpm/guard-behavior-fixture/sibling.mjs")),state:attempt(path.join(root,"data/yunzai-guard/forbidden-state.txt")),outside:{...outsideWrite,hostMarkerVisible:namespaceBefore?.includes("original host data")===true,namespaceBefore,namespaceAfter}},
    privateEnv:Object.keys(process.env).filter(key=>/^YUNZAI_GUARD_(?:PIPE|RUNTIME_MANIFEST|PARENT_RUNTIME|ORIGIN_PLUGIN)$/.test(key))}
}
`

const forkSource = `import fs from "node:fs"
import path from "node:path"
fs.writeFileSync(path.join(process.argv[2],process.argv[5]+"-entry-started.json"),JSON.stringify({pid:process.pid,channel:process.connected,send:typeof process.send}))
const {probe}=await import("./probe.mjs")
fs.writeFileSync(path.join(process.argv[2],process.argv[5]+"-entry-linked.json"),JSON.stringify({pid:process.pid}))
process.once("message",message=>{
  const result={kind:"business-fork",request:message,value:probe(process.argv[2],process.argv[3],process.argv[4],process.argv[5])}
  process.send(result,()=>process.disconnect())
})
process.send({kind:"business-ready"})
`

const workerSource = `import fs from "node:fs"
import path from "node:path"
import {parentPort,workerData} from "node:worker_threads"
import {fork} from "node:child_process"
import {probe} from "./probe.mjs"
const {own,root,outside,forkFile,preload,tag,buffer}=workerData
const flags=process.platform==="win32"?["--preserve-symlinks","--preserve-symlinks-main"]:[]
fs.writeFileSync(path.join(own,"worker-before-fork.json"),JSON.stringify({pid:process.pid}))
const child=fork(forkFile,[own,root,outside,"worker-fork"],{env:{APP_NATIVE_BEHAVIOR:"worker-fork"},execArgv:[...flags,"--require",preload],${forkStdio}})
fs.writeFileSync(path.join(own,"worker-after-fork.json"),JSON.stringify({pid:process.pid,childPid:child.pid}))
const messages=[],events=[];let stderr="";child.stderr?.on("data",chunk=>stderr+=chunk);child.on("spawn",()=>events.push("spawn"));child.on("message",value=>{messages.push(value);if(value.kind==="business-ready")child.send({kind:"application-request",tag})})
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{const detail={pid:child.pid,spawnfile:child.spawnfile,spawnargs:child.spawnargs,connected:child.connected,exitCode:child.exitCode,signalCode:child.signalCode,events,messages,stderr};fs.writeFileSync(path.join(own,"worker-fork-timeout.json"),JSON.stringify(detail));child.kill();reject(Error("worker fork timeout:"+JSON.stringify(detail)))},8000);child.once("error",error=>{clearTimeout(timer);reject(error)});child.once("exit",code=>{clearTimeout(timer);code?reject(Error("worker fork "+code+":"+stderr)):resolve()})})
parentPort.postMessage({kind:"business-worker",tag,byte:new Uint8Array(buffer)[0],value:probe(own,root,outside,"worker"),messages})
`

const observerSource = `import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {Worker} from "node:worker_threads"
import {fork,spawn} from "node:child_process"
import {probe} from "./probe.mjs"
const own=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(own,"../.."),outside=path.resolve(root,"../host-owned.txt")
const identity=()=>({pid:process.pid,namespace:process.platform==="linux"?fs.readlinkSync("/proc/self/ns/pid"):null})
export class Observer extends plugin {
  constructor(){super({name:"Native behavior observer",event:"message",priority:100,rule:[{reg:"^#native-observe$",fnc:"observe"}]})}
  init(){fs.appendFileSync(path.join(own,"initializers.jsonl"),JSON.stringify(identity())+"\\n");this.addCleanup(()=>fs.appendFileSync(path.join(own,"cleanups.jsonl"),JSON.stringify(identity())+"\\n"))}
  async observe(){
    const preload=path.join(own,"application-preload.cjs"),forkFile=path.join(own,"application-fork.mjs")
    const direct=spawn(process.execPath,["-e","require('node:fs').writeFileSync("+JSON.stringify(path.join(own,"direct-node-started.txt"))+",'started')"],{stdio:"ignore",env:{APP_NATIVE_BEHAVIOR:"direct-node"}})
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{direct.kill();reject(Error("Direct Node startup timed out"))},8000);direct.once("error",error=>{clearTimeout(timer);reject(error)});direct.once("exit",code=>{clearTimeout(timer);code?reject(Error("Direct Node startup failed "+code)):resolve()})})
    const flags=process.platform==="win32"?["--preserve-symlinks","--preserve-symlinks-main"]:[]
    fs.writeFileSync(path.join(own,"main-before-fork.json"),JSON.stringify({pid:process.pid}))
    const child=fork(forkFile,[own,root,outside,"main-fork"],{env:{APP_NATIVE_BEHAVIOR:"main-fork"},execArgv:[...flags,"--require",preload],${forkStdio}})
    fs.writeFileSync(path.join(own,"main-after-fork.json"),JSON.stringify({pid:process.pid,childPid:child.pid}))
    const messages=[],events=[];let stderr="";child.stderr?.on("data",chunk=>stderr+=chunk);child.on("spawn",()=>events.push("spawn"));child.on("message",value=>{messages.push(value);if(value.kind==="business-ready")child.send({kind:"application-request",tag:"direct-preserved"})})
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{const detail={pid:child.pid,spawnfile:child.spawnfile,spawnargs:child.spawnargs,connected:child.connected,exitCode:child.exitCode,signalCode:child.signalCode,events,messages,stderr};fs.writeFileSync(path.join(own,"main-fork-timeout.json"),JSON.stringify(detail));child.kill();reject(Error("main fork timeout:"+JSON.stringify(detail)))},8000);child.once("error",error=>{clearTimeout(timer);reject(error)});child.once("exit",code=>{clearTimeout(timer);code?reject(Error("main fork "+code+":"+stderr)):resolve()})})
    const buffer=new ArrayBuffer(4);new Uint8Array(buffer)[0]=42
    const worker=new Worker(new URL("./application-worker.mjs",import.meta.url),{execArgv:[...flags,"--require",preload],workerData:{own,root,outside,forkFile,preload,buffer,tag:"transfer-preserved"},transferList:[buffer]})
    const workerMessages=[];worker.on("message",value=>workerMessages.push(value))
    await new Promise((resolve,reject)=>{worker.once("error",reject);worker.once("exit",code=>code?reject(Error("worker "+code)):resolve())})
    const value={...identity(),main:probe(own,root,outside,"main"),messages,workerMessages,detachedBytes:buffer.byteLength}
    fs.writeFileSync(path.join(own,"observation.json"),JSON.stringify(value))
    await this.reply(JSON.stringify(value))
    return true
  }
}
`

function offenderSource(action) {
  const code = `import fs from "node:fs";import {execFileSync} from "node:child_process";import {parentPort,workerData} from "node:worker_threads";
fs.writeFileSync(workerData.attempt,JSON.stringify({attempted:true,pid:process.pid}));
try{execFileSync(process.execPath,["-e",workerData.script]);parentPort.postMessage({blocked:false})}catch(error){fs.writeFileSync(workerData.blocked,JSON.stringify({blocked:error.code==="GUARD_DENIED",code:error.code}));parentPort.postMessage({blocked:error.code==="GUARD_DENIED",code:error.code})}`
  return `import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {Worker} from "node:worker_threads"
import {execFileSync} from "node:child_process"
const own=path.dirname(fileURLToPath(import.meta.url))
export class Offender extends plugin {
  constructor(){super({name:"Native behavior offender",event:"message",priority:100,rule:[{reg:"^#native-violate$",fnc:"violate"}]})}
  async violate(){
    const marker=path.join(own,"forbidden-process-marker.txt"),attempt=path.join(own,"attempted.json"),blocked=path.join(own,"blocked.json")
    const script="require('node:fs').writeFileSync("+JSON.stringify(marker)+",'unexpected process side effect')"
    ${action === "deny" ? `const worker=new Worker(${JSON.stringify(code)},{eval:true,workerData:{attempt,blocked,script}});await new Promise((resolve,reject)=>{worker.once("error",reject);worker.once("exit",resolve)})` : `fs.writeFileSync(attempt,JSON.stringify({attempted:true,pid:process.pid}));try{execFileSync(process.execPath,["-e",script])}catch(error){fs.writeFileSync(blocked,JSON.stringify({blocked:error.code==="GUARD_DENIED",code:error.code}))}`}
    return true
  }
}
`
}

const trustedSource = `import fs from "node:fs"
const file="data/native-behavior-trusted.json"
const save=value=>fs.writeFileSync(file,JSON.stringify(value))
export class TrustedPeer extends plugin {
  constructor(){super({name:"Trusted behavior peer",event:"message",priority:100,rule:[{reg:"^#trusted-peer$",fnc:"ping"}]})}
  init(){const value=JSON.parse(fs.readFileSync(file,"utf8"));value.starts++;value.pid=process.pid;save(value);Bot.once("exit",()=>{const value=JSON.parse(fs.readFileSync(file,"utf8"));value.cleanups++;save(value)})}
  async ping(){const value=JSON.parse(fs.readFileSync(file,"utf8"));value.commands++;save(value);await this.reply(JSON.stringify(value));return true}
}
`

function driverSource(action) {
  return `import fs from "node:fs"
import loader from "../../lib/plugins/loader.js"
export class Driver extends plugin {
  constructor(){super({name:"Trusted behavior integration driver",rule:[]})}
  init(){const context=globalThis[Symbol.for("yunzai.guard.context.v1")];Bot.once("online",()=>setTimeout(async()=>{
    const result={corePid:process.pid,generation:context.generation,replies:[]}
    const put=name=>fs.writeFileSync("data/native-behavior-"+name+"-"+context.generation+".json",JSON.stringify(result))
    const dispatch=async text=>loader.deal({self_id:"behavior-fixture",user_id:"behavior-user",post_type:"message",message_type:"private",isPrivate:true,message:[{type:"text",text}],raw_message:text,reply:async value=>{result.replies.push({text,reply:JSON.parse(value)});return {message_id:"behavior-fixture"}}})
    try {
      await dispatch("#native-observe")
      if(result.replies.at(-1)?.text!=="#native-observe")throw Error("Observer did not complete its application IPC/alias/confinement checks")
      await dispatch("#trusted-peer")
      put("ready")
      if(context.generation===1){
        await dispatch("#native-violate")
        ${action === "deny" ? `const deadline=performance.now()+10000;while(loader.priority.some(row=>row.key===${JSON.stringify(offenderId)})){if(performance.now()>deadline)throw Error("Denied plugin registrations still present");await new Promise(resolve=>setTimeout(resolve,40))}` : ""}
      }
      await dispatch("#trusted-peer")
      await dispatch("#native-observe")
      result.offenderPresent=loader.priority.some(row=>row.key===${JSON.stringify(offenderId)})
    }catch(error){result.error=String(error.stack)}
    put("finished")
  },200))}
}
`
}

function validateObservation(value, root, expectedPreload = false) {
  assert.equal(value.runtime, expectedPreload)
  assert.deepEqual(value.alias.esm, "original-esm-relative")
  assert.deepEqual(value.alias.cjs, "original-cjs-relative")
  assert.match(
    value.alias.location,
    /\/node_modules\/\.pnpm\/guard-behavior-fixture\/esm\/index\.mjs$/,
  )
  assert.equal(value.alias.location.includes("/node_modules/guard-behavior-esm/"), false)
  assert.equal(value.alias.preload, value.label === "main" ? null : "original-cjs-relative")
  assert.equal(value.writes.own, true)
  for (const [name, denial] of Object.entries(value.writes))
    if (name !== "own") {
      if (name === "outside" && process.platform === "linux") {
        assert.equal(
          denial.hostMarkerVisible,
          false,
          "Host marker must not be mounted into the private ancestor namespace",
        )
        if (!denial.blocked)
          assert.ok(denial.namespaceAfter?.startsWith("unexpected outside write"))
        continue
      }
      assert.equal(denial.blocked, true, `${value.label}: ${name} write escaped sandbox`)
      assert.ok(["EACCES", "EPERM", "EROFS", "ENOENT"].includes(denial.code))
    }
  if (!expectedPreload) assert.deepEqual(value.privateEnv, [])
  assert.notEqual(value.pid, undefined)
}

function validateReply(reply, root) {
  assert.equal(reply.detachedBytes, 0)
  validateObservation(reply.main, root, true)
  assert.equal(
    reply.messages.length,
    2,
    "ordinary fork IPC must contain only its two application messages",
  )
  assert.deepEqual(reply.messages[0], { kind: "business-ready" })
  const fork = reply.messages[1]
  assert.equal(fork.kind, "business-fork")
  assert.deepEqual(fork.request, { kind: "application-request", tag: "direct-preserved" })
  validateObservation(fork.value, root)
  assert.equal(reply.workerMessages.length, 1, "Worker messages must exclude private Guard traffic")
  const worker = reply.workerMessages[0]
  assert.equal(worker.kind, "business-worker")
  assert.equal(worker.tag, "transfer-preserved")
  assert.equal(worker.byte, 42)
  validateObservation(worker.value, root, true)
  assert.equal(worker.messages.length, 2)
  assert.deepEqual(worker.messages[0], { kind: "business-ready" })
  assert.equal(worker.messages[1].kind, "business-fork")
  assert.deepEqual(worker.messages[1].request, {
    kind: "application-request",
    tag: "transfer-preserved",
  })
  validateObservation(worker.messages[1].value, root)
}

for (const action of ["deny", "restart"])
  test(
    `real native behavior ${action} preserves application IPC, confinement and unrelated plugin state`,
    {
      skip: enabled
        ? false
        : "requires GUARD_TEST_NATIVE_BEHAVIOR=1 and Windows AppContainer/Linux bubblewrap",
      timeout: 300000,
    },
    async t => {
      const ruleId = `native-process-${action}`
      const fixture = await createEnvironmentFixture({
        mode: "managed",
        label: `native-behavior-${action}`,
        probe: false,
        ...(guardSource ? { guardSource } : {}),
        settings: {
          shutdownTimeout: 15000,
          startupTimeout: 60000,
          recovery: {
            maxRestarts: action === "restart" ? 1 : 0,
            windowMs: 60000,
            baseDelayMs: 50,
            maxDelayMs: 100,
          },
          rules: [
            { id: ruleId, plugin: offenderId, kind: "process", operation: "execFileSync", action },
          ],
          pluginSandbox: {
            native: { plugins: ids.map(id => ({ id, timeoutMs: 30000, network: "none" })) },
          },
        },
      })
      t.diagnostic(`Evidence: ${fixture.runRoot}`)
      const files = {
        [`plugins/${observerId}/index.js`]: observerSource,
        [`plugins/${observerId}/probe.mjs`]: probeSource,
        [`plugins/${observerId}/application-fork.mjs`]: forkSource,
        [`plugins/${observerId}/application-worker.mjs`]: workerSource,
        [`plugins/${observerId}/application-preload.cjs`]:
          'const fs=require("node:fs"),path=require("node:path"),{threadId}=require("node:worker_threads");const prefix=path.join(__dirname,"preload-"+process.pid+"-"+threadId);fs.writeFileSync(prefix+"-started.json",JSON.stringify({pid:process.pid,threadId,argv:process.argv,connected:process.connected,send:typeof process.send}));globalThis.behaviorPreload=require("guard-behavior-cjs");fs.writeFileSync(prefix+"-resolved.json",JSON.stringify({pid:process.pid,threadId,alias:globalThis.behaviorPreload}))\n',
        [`plugins/${offenderId}/index.js`]: offenderSource(action),
        "plugins/native-behavior-trusted/index.js": trustedSource,
        "plugins/native-behavior-driver/index.js": driverSource(action),
        "node_modules/.pnpm/guard-behavior-fixture/sibling.mjs":
          'export default "original-esm-relative"\n',
        "node_modules/.pnpm/guard-behavior-fixture/sibling.cjs":
          'module.exports="original-cjs-relative"\n',
        "node_modules/.pnpm/guard-behavior-fixture/esm/index.mjs":
          'export {default} from "../sibling.mjs";export const location=import.meta.url\n',
        "node_modules/.pnpm/guard-behavior-fixture/esm/package.json":
          '{"name":"guard-behavior-esm","type":"module","main":"index.mjs"}\n',
        "node_modules/.pnpm/guard-behavior-fixture/cjs/index.cjs":
          'module.exports=require("../sibling.cjs")\n',
        "node_modules/.pnpm/guard-behavior-fixture/cjs/package.json":
          '{"name":"guard-behavior-cjs","main":"index.cjs"}\n',
      }
      const sourceHashesBefore = {}
      for (const [name, source] of Object.entries(files)) {
        const file = path.join(fixture.root, name)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        if (!name.endsWith(".json")) {
          const syntax = spawnSync(
            process.execPath,
            ["--check", "--input-type=" + (name.endsWith(".cjs") ? "commonjs" : "module")],
            { input: source, encoding: "utf8" },
          )
          assert.equal(syntax.status, 0, `${name}: ${syntax.stderr}`)
        }
        fs.writeFileSync(file, source, "utf8")
        sourceHashesBefore[name] = sha(source)
      }
      for (const kind of ["esm", "cjs"])
        fs.symlinkSync(
          path.join(fixture.root, "node_modules/.pnpm/guard-behavior-fixture", kind),
          path.join(fixture.root, "node_modules/guard-behavior-" + kind),
          process.platform === "win32" ? "junction" : "dir",
        )
      const outside = path.join(fixture.runRoot, "host-owned.txt")
      fs.writeFileSync(outside, "original host data", "utf8")
      const originalTrustedState = {
        seed: "original business data",
        starts: 0,
        commands: 0,
        cleanups: 0,
      }
      const trustedState = path.join(fixture.root, "data/native-behavior-trusted.json")
      fs.writeFileSync(trustedState, JSON.stringify(originalTrustedState), "utf8")
      const guardBuild = Object.fromEntries(
        ["dist", "native"]
          .flatMap(directory =>
            fs
              .readdirSync(path.join(fixture.pluginDir, directory), {
                recursive: true,
                withFileTypes: true,
              })
              .filter(entry => entry.isFile())
              .map(entry => {
                const file = path.join(entry.parentPath, entry.name)
                return [
                  path.relative(fixture.pluginDir, file).replaceAll("\\", "/"),
                  sha(fs.readFileSync(file)),
                ]
              }),
          )
          .sort(([a], [b]) => a.localeCompare(b)),
      )
      const manifest = JSON.stringify(guardBuild, null, 2) + "\n"
      fs.writeFileSync(path.join(fixture.runRoot, "guard-build-manifest.json"), manifest, "utf8")
      const report = {
        platform: process.platform,
        node: process.version,
        action,
        ruleId,
        scope:
          "Generated original APIs in real 47-file core; JS guest/Worker observations and OS-confined ordinary forks, not ordinary fork syscall instrumentation",
        network: "none",
        forkStdio: ipcOnlyDiagnostic ? "ipc-only-diagnostic" : "silent-default",
        redis: fixture.redisFixture,
        sourceHashesBefore,
        guardBuild: {
          files: Object.keys(guardBuild).length,
          sha256: sha(manifest),
          manifest: "guard-build-manifest.json",
          source: guardSource ? fs.realpathSync.native(guardSource) : "repository",
        },
      }
      const logPath = path.join(fixture.runRoot, "native-behavior.log"),
        log = fs.openSync(logPath, "w")
      const child = spawn(process.execPath, [fixture.launcher], {
        cwd: fixture.root,
        env: { ...process.env, NODE_OPTIONS: "" },
        stdio: ["ignore", log, log],
        windowsHide: true,
      })
      fs.closeSync(log)
      let failure
      const eventRows = () =>
        fixture.events().filter(row => ["audit", "violation"].includes(row.type))
      const marker = path.join(fixture.root, "plugins", offenderId, "forbidden-process-marker.txt")
      try {
        const first = await fixture.waitOnline()
        assert.equal(first.generation, 1)
        report.first = {
          hostPid: first.hostPid,
          corePid: first.workerPid,
          generation: first.generation,
        }
        const ready = await waitFor(
          () =>
            readJson(path.join(fixture.root, "data/native-behavior-ready-1.json")) ??
            readJson(path.join(fixture.root, "data/native-behavior-finished-1.json")),
          "Observer's real IPC/alias/confinement checks did not finish; inspect native-behavior.log",
        )
        report.ready = ready
        assert.equal(ready.error, undefined)
        assert.equal(ready.replies[0].text, "#native-observe")
        validateReply(ready.replies[0].reply, fixture.root)
        const denied = await waitFor(
          () =>
            eventRows().find(
              row => row.event.ruleId === ruleId && row.event.operation === "execFileSync",
            ),
          "Parent did not receive configured native process violation",
        )
        assert.equal(denied.event.plugin, offenderId)
        assert.equal(denied.event.action, action)
        assert.equal(denied.event.details.source, "guest-reported")
        assert.equal(denied.event.details.reportedBlocked, true)
        assert.equal(
          denied.event.details.guestRuntime.kind,
          action === "deny" ? "thread" : "node-process",
        )
        assert.equal(fs.existsSync(marker), false)
        report.violation = denied
        let finalStatus = first
        if (action === "restart") {
          finalStatus = await fixture.waitOnline(2)
          assert.equal(finalStatus.generation, 2)
          assert.equal(finalStatus.hostPid, first.hostPid)
          assert.notEqual(finalStatus.workerPid, first.workerPid)
        }
        const finished = await waitFor(
          () =>
            readJson(
              path.join(
                fixture.root,
                `data/native-behavior-finished-${finalStatus.generation}.json`,
              ),
            ),
          "Core did not resume unaffected trusted/native plugins after policy action",
        )
        report.finished = finished
        assert.equal(finished.error, undefined, finished.error)
        assert.equal(finished.corePid, finalStatus.workerPid)
        for (const row of finished.replies)
          if (row.text === "#native-observe") validateReply(row.reply, fixture.root)
        const trusted = finished.replies
          .filter(row => row.text === "#trusted-peer")
          .map(row => row.reply)
        assert.equal(trusted.length, 2)
        assert.equal(trusted[1].commands, trusted[0].commands + 1)
        for (const value of trusted) {
          assert.equal(value.seed, originalTrustedState.seed)
          assert.equal(value.pid, finalStatus.workerPid)
          assert.equal(value.starts, finalStatus.generation)
        }
        assert.equal(finished.offenderPresent, action === "restart")
        const stable = await fixture.status()
        assert.equal(stable.generation, action === "restart" ? 2 : 1)
        assert.equal(stable.workerPid, finalStatus.workerPid)
        assert.equal(stable.phase, "online")
        report.final = {
          hostPid: stable.hostPid,
          corePid: stable.workerPid,
          generation: stable.generation,
        }
        const observerEvents = eventRows()
          .filter(row => row.event.plugin === observerId)
          .map(row => row.event)
        for (const operation of [
          "fork",
          "worker-runtime-registered",
          "external-runtime-unobservable",
        ])
          assert.ok(
            observerEvents.some(row => row.operation === operation),
            `Missing fixed-plugin observer event: ${operation}`,
          )
        assert.equal(
          observerEvents.some(row => row.operation === "runtime-bootstrap-failed"),
          false,
        )
        assert.equal(fs.existsSync(marker), false)
        assert.ok(fs.existsSync(path.join(fixture.root, "plugins", offenderId, "attempted.json")))
        assert.equal(
          fs.existsSync(path.join(fixture.root, "plugins", offenderId, "forbidden-peer.txt")),
          false,
        )
        assert.equal(fs.existsSync(path.join(fixture.stateDir, "forbidden-state.txt")), false)
        assert.equal(fs.readFileSync(outside, "utf8"), "original host data")
        report.status = "passed"
      } catch (error) {
        failure = error
        report.status = "failed"
        report.failure = String(error.stack)
      } finally {
        try {
          Object.assign(report, await fixture.finish({ timeout: 45000 }))
          await waitFor(
            () => child.exitCode !== null || child.signalCode !== null,
            "Behavior fixture launcher did not stop",
            15000,
          )
          report.scopeStopped = true
          report.cleanup = true
          report.events = eventRows().filter(row => ids.includes(row.event.plugin))
          report.activeJournals = fs
            .readdirSync(fixture.stateDir)
            .filter(name => /^windows-sandbox.*-active\.json$/.test(name))
          assert.deepEqual(report.activeJournals, [])
          for (const id of ids) {
            const started = report.events.filter(
              row => row.event.plugin === id && row.event.operation === "native.process-started",
            )
            const closed = report.events.filter(
              row => row.event.plugin === id && row.event.operation === "native.process-closed",
            )
            assert.equal(started.length, report.final?.generation ?? 1)
            assert.equal(closed.length, started.length)
          }
          report.trustedState = readJson(trustedState)
          assert.equal(report.trustedState.seed, originalTrustedState.seed)
          assert.equal(report.trustedState.cleanups, report.final?.generation ?? 1)
        } catch (error) {
          failure ??= error
          report.status = "failed"
          report.cleanup = false
          report.cleanupError = String(error.stack)
        }
        report.sourceHashesAfter = Object.fromEntries(
          Object.keys(sourceHashesBefore).map(file => [
            file,
            sha(fs.readFileSync(path.join(fixture.root, file))),
          ]),
        )
        try {
          assert.deepEqual(report.sourceHashesAfter, sourceHashesBefore)
          Object.assign(report, fixture.verifyCoreHashes())
          assert.equal(fs.existsSync(marker), false)
        } catch (error) {
          failure ??= error
          report.status = "failed"
          report.verificationError = String(error.stack)
        }
        fs.writeFileSync(
          path.join(fixture.runRoot, "native-behavior-report.json"),
          JSON.stringify(report, null, 2) + "\n",
          "utf8",
        )
      }
      if (failure) throw failure
    },
  )
