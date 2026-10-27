import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import http from "node:http"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { pathToFileURL } from "node:url"
import { nativeBehaviorSettings } from "../dist/native-sandbox/behavior.js"

const behavior = new URL("../dist/native-sandbox/behavior.js", import.meta.url).href
const nativePreload = new URL("../dist/native-sandbox/preload.js", import.meta.url).href
const pluginId = "NativePlugin-" + "a".repeat(115)

async function fixture(t, { rules = [], protect = { enabled: false } } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "guard-native-behavior-"))
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const manifest = path.join(directory, "alias-only.json")
  fs.writeFileSync(manifest, JSON.stringify({ version: 1, aliases: {} }))
  return {
    directory,
    manifest,
    async run(source, extraArgs = []) {
      const filename = path.join(directory, "main.mjs")
      fs.writeFileSync(
        filename,
        `
import assert from "node:assert/strict"
import { installNativeBehavior } from ${JSON.stringify(behavior)}
const policy = ${JSON.stringify({ rules, protect })}
const handle = installNativeBehavior({pluginId:${JSON.stringify(pluginId)},identity:{id:"native-fixture",generation:7},settings:policy,resolutionManifestPath:${JSON.stringify(manifest)},
  emit:event=>process.send({type:"behavior",event})})
await handle.ready
${source}
`,
      )
      const env = {
        ...process.env,
        YUNZAI_GUARD_RUNTIME_MANIFEST: manifest,
        YUNZAI_GUARD_PIPE: "\\\\.\\pipe\\yunzai-guard-not-a-broker",
        YUNZAI_GUARD_PARENT_RUNTIME: "private-parent",
      }
      delete env.NODE_OPTIONS
      const child = spawn(process.execPath, ["--import", nativePreload, ...extraArgs, filename], {
        env,
        cwd: directory,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      })
      const messages = []
      let stderr = "",
        stdout = ""
      child.on("message", value => messages.push(value))
      child.stderr.on("data", chunk => {
        stderr += chunk
      })
      child.stdout.on("data", chunk => {
        stdout += chunk
      })
      const timer = setTimeout(() => child.kill("SIGKILL"), 15000)
      timer.unref()
      try {
        const [code, signal] = await once(child, "close")
        assert.equal(code, 0, `${stderr}\n${stdout}\nSignal:${signal}`)
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      }
      assert.equal(messages.filter(message => message.type === "preload-hello").length, 1)
      return {
        messages,
        events: messages
          .filter(message => message.type === "behavior")
          .map(message => message.event),
        result: messages.find(message => message.type === "result")?.result,
      }
    },
  }
}

test("compact native policy drops core protection targets and unrelated plugin configuration", () => {
  const settings = nativeBehaviorSettings({
    rules: [{ id: "network", kind: "network", action: "deny" }],
    protect: { targets: ["Bot.em"] },
    pluginSandbox: { native: { plugins: [{ id: "other-plugin" }] } },
  })
  assert.deepEqual(settings.protect.targets, [])
  assert.deepEqual(settings.pluginSandbox.native.plugins, [])
  assert.equal(settings.rules[0].action, "deny")
  assert.ok(
    Object.isFrozen(settings) &&
      Object.isFrozen(settings.rules) &&
      Object.isFrozen(settings.rules[0]),
  )
})

test("full 128-character native identity blocks network and exec before effects without a broker", async t => {
  assert.equal(pluginId.length, 128)
  const receiver = net.createServer(socket => socket.destroy())
  let connections = 0
  receiver.on("connection", () => connections++)
  await new Promise(resolve => receiver.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise(resolve => receiver.close(resolve)))
  const probe = await fixture(t, {
    rules: [
      { id: "native-network", plugin: pluginId, kind: "network", action: "deny" },
      { id: "native-exec", plugin: pluginId, operation: "execFileSync", action: "restart" },
    ],
  })
  const marker = path.join(probe.directory, "must-not-exist")
  const result = await probe.run(`
import { execFileSync } from "node:child_process"
import http from "node:http"
assert.throws(()=>http.get("http://127.0.0.1:${receiver.address().port}/blocked?token=not-logged"),{code:"GUARD_DENIED"})
await assert.rejects(fetch("http://127.0.0.1:${receiver.address().port}/blocked"),{code:"GUARD_DENIED"})
assert.throws(()=>execFileSync(process.execPath,["-e",${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`)}]),{code:"GUARD_DENIED"})
assert.throws(()=>installNativeBehavior({pluginId:"another",identity:{id:"twice",generation:1},settings:{},emit(){}}),/已安装 Guard 运行时/)
handle.dispose(); handle.dispose()
process.send({type:"result",result:{done:true}},()=>process.disconnect())
`)
  assert.equal(fs.existsSync(marker), false)
  assert.equal(connections, 0)
  for (const operation of ["http.get", "fetch", "execFileSync"]) {
    const event = result.events.find(value => value.operation === operation)
    assert.equal(event.plugin, pluginId)
    assert.equal(event.details.blocked, true)
    assert.equal(event.details.runtime.originPlugin, pluginId)
    assert.equal(event.action, operation === "execFileSync" ? "restart" : "deny")
  }
  assert.equal(JSON.stringify(result.events).includes("not-logged"), false)
})

test("native nested Workers preserve data and enforce identical local rules through private ports", async t => {
  const probe = await fixture(t, {
    rules: [
      { id: "native-worker-exec", plugin: pluginId, operation: "execFileSync", action: "restart" },
      { id: "native-worker-network", plugin: pluginId, kind: "network", action: "deny" },
    ],
  })
  const marker = path.join(probe.directory, "worker-must-not-exist")
  const inner = `import{parentPort,workerData}from"node:worker_threads";import{execFileSync}from"node:child_process";
let execCode,netCode;try{execFileSync(process.execPath,["-e",${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`)}])}catch(e){execCode=e.code}
try{await fetch("http://127.0.0.1:1/blocked")}catch(e){netCode=e.code}
parentPort.postMessage({execCode,netCode,tag:workerData.tag,byte:new Uint8Array(workerData.buffer)[0],nativePreload:process.execArgv.includes(${JSON.stringify(nativePreload)})});`
  const outer = `import{Worker,parentPort,workerData}from"node:worker_threads";const child=new Worker(${JSON.stringify(inner)},{eval:true,execArgv:[],workerData,transferList:[workerData.buffer]});child.on("message",value=>parentPort.postMessage(value));child.on("error",e=>{throw e});`
  const output = await probe.run(`
import { Worker } from "node:worker_threads"
const buffer=new ArrayBuffer(4);new Uint8Array(buffer)[0]=42
const worker=new Worker(${JSON.stringify(outer)},{eval:true,workerData:{buffer,tag:"preserved"},transferList:[buffer]})
assert.equal(buffer.byteLength,0)
let result
worker.on("message",value=>{result=value})
await new Promise((resolve,reject)=>{worker.once("exit",code=>code?reject(Error("worker failed "+code)):resolve());worker.once("error",reject)})
handle.dispose()
process.send({type:"result",result},()=>process.disconnect())
`)
  assert.deepEqual(output.result, {
    execCode: "GUARD_DENIED",
    netCode: "GUARD_DENIED",
    tag: "preserved",
    byte: 42,
    nativePreload: false,
  })
  assert.equal(fs.existsSync(marker), false)
  const registered = output.events.filter(value => value.operation === "worker-runtime-registered")
  assert.equal(registered.length, 2)
  for (const id of ["native-worker-exec", "native-worker-network"]) {
    const event = output.events.find(value => value.ruleId === id)
    assert.ok(event, `private Worker report received: ${id}`)
    assert.equal(event.plugin, pluginId)
    assert.equal(event.details.runtime.kind, "thread")
    assert.equal(event.details.runtime.originPlugin, pluginId)
  }
  assert.equal(
    output.events.some(value => value.operation === "runtime-bootstrap-failed"),
    false,
  )
})

test("native ordinary fork IPC contains business messages only, including a fork from a Worker", async t => {
  const probe = await fixture(t)
  const business = path.join(probe.directory, "business.mjs")
  const userPreload = path.join(probe.directory, "user.mjs")
  fs.writeFileSync(userPreload, "globalThis.businessPreload=true\n")
  fs.writeFileSync(
    business,
    `process.send({business:true,guard:Boolean(globalThis[Symbol.for("yunzai.guard.runtime.v1")]),preload:globalThis.businessPreload===true,
    privateEnv:Object.keys(process.env).filter(key=>/^YUNZAI_GUARD_(?:PIPE|RUNTIME_MANIFEST|PARENT_RUNTIME|ORIGIN_PLUGIN)$/.test(key))})\n`,
  )
  const worker = `import{parentPort}from"node:worker_threads";import{fork}from"node:child_process";
const child=fork(${JSON.stringify(business)},{silent:true});let messages=[];child.on("message",value=>messages.push(value));child.on("error",e=>{throw e});child.on("exit",code=>{if(code)throw Error("fork failed");parentPort.postMessage(messages)});`
  const result = await probe.run(
    `
import { fork, execFile } from "node:child_process"
import { Worker } from "node:worker_threads"
const child=fork(${JSON.stringify(business)},{silent:true})
const messages=[];child.on("message",value=>messages.push(value))
await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",code=>code?reject(Error("fork failed")):resolve())})
const direct=await new Promise((resolve,reject)=>execFile(process.execPath,["-p","Boolean(globalThis[Symbol.for('yunzai.guard.runtime.v1')])"],(e,out)=>e?reject(e):resolve(out.trim())))
const worker=new Worker(${JSON.stringify(worker)},{eval:true})
let nested;worker.on("message",value=>{nested=value})
await new Promise((resolve,reject)=>{worker.once("error",reject);worker.once("exit",code=>code?reject(Error("worker failed")):resolve())})
handle.dispose()
process.send({type:"result",result:{messages,nested,direct}},()=>process.disconnect())
`,
    ["--import", pathToFileURL(userPreload).href],
  )
  const expected = [{ business: true, guard: false, preload: true, privateEnv: [] }]
  assert.deepEqual(result.result.messages, expected)
  assert.deepEqual(result.result.nested, expected)
  assert.equal(result.result.direct, "false")
  assert.ok(result.events.some(event => event.operation === "external-runtime-unobservable"))
  assert.equal(
    result.events.some(event => event.operation === "node-runtime-requested"),
    false,
  )
})

test("alias-only module resolution reaches nested Workers and ordinary forks before application preloads", async t => {
  const probe = await fixture(t)
  for (const folder of ["node_modules", "lib/wrapper-esm", "lib/wrapper-cjs"])
    fs.mkdirSync(path.join(probe.directory, folder), { recursive: true })
  fs.writeFileSync(path.join(probe.directory, "lib/sibling.mjs"), 'export default "esm-original"')
  fs.writeFileSync(path.join(probe.directory, "lib/sibling.cjs"), 'module.exports="cjs-original"')
  fs.writeFileSync(
    path.join(probe.directory, "lib/wrapper-esm/index.mjs"),
    'export {default} from "../sibling.mjs"',
  )
  fs.writeFileSync(
    path.join(probe.directory, "lib/wrapper-cjs/index.cjs"),
    'module.exports=require("../sibling.cjs")',
  )
  const links = ["esm", "cjs"].map(kind => ({
    from: `node_modules/wrapper-${kind}`,
    to: `lib/wrapper-${kind}`,
  }))
  for (const link of links)
    fs.symlinkSync(
      path.join(probe.directory, link.to),
      path.join(probe.directory, link.from),
      process.platform === "win32" ? "junction" : "dir",
    )
  fs.writeFileSync(
    probe.manifest,
    JSON.stringify({ version: 1, moduleAliases: { root: probe.directory, links } }),
  )
  const esm = pathToFileURL(path.join(probe.directory, "node_modules/wrapper-esm/index.mjs")).href
  const cjs = path.join(probe.directory, "node_modules/wrapper-cjs/index.cjs")
  const user = path.join(probe.directory, "user.cjs")
  fs.writeFileSync(user, `globalThis.aliasBeforeRequire=require(${JSON.stringify(cjs)})`)
  const application = `import value from ${JSON.stringify(esm)};import{createRequire}from"node:module";
const result={esm:value,cjs:createRequire(import.meta.url)(${JSON.stringify(cjs)}),preload:globalThis.aliasBeforeRequire};`
  const forkFile = path.join(probe.directory, "fork.mjs")
  fs.writeFileSync(forkFile, application + "process.send(result)")
  const inner =
    application + 'import{parentPort}from"node:worker_threads";parentPort.postMessage(result)'
  const outer = `import{Worker,parentPort}from"node:worker_threads";const worker=new Worker(${JSON.stringify(inner)},{eval:true,execArgv:["--require",${JSON.stringify(user)}]});worker.on("message",value=>parentPort.postMessage(value));worker.on("error",error=>{throw error});`
  const output = await probe.run(
    `
import {Worker} from "node:worker_threads"
import {fork} from "node:child_process"
const child=fork(${JSON.stringify(forkFile)},{env:{},execArgv:["--require",${JSON.stringify(user)}],silent:true})
const messages=[];let errors="";child.stderr.on("data",chunk=>errors+=chunk);child.on("message",value=>messages.push(value))
await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",code=>code?reject(Error(errors)):resolve())})
const worker=new Worker(${JSON.stringify(outer)},{eval:true,execArgv:[]});let nested
worker.on("message",value=>{nested=value})
await new Promise((resolve,reject)=>{worker.once("error",reject);worker.once("exit",code=>code?reject(Error("worker failed "+code)):resolve())})
handle.dispose();process.send({type:"result",result:{messages,nested}},()=>process.disconnect())
`,
    ["--preserve-symlinks", "--preserve-symlinks-main"],
  )
  const expected = { esm: "esm-original", cjs: "cjs-original", preload: "cjs-original" }
  assert.deepEqual(output.result, { messages: [expected], nested: expected })
  assert.equal(
    output.events.filter(value => value.operation === "worker-runtime-registered").length,
    2,
  )
  assert.equal(
    output.events.some(value => value.operation === "runtime-bootstrap-failed"),
    false,
  )
})

test("default audit allows loopback requests and dispose keeps permanent self-protection", async t => {
  const receiver = http.createServer((_request, response) => {
    response.setHeader("Connection", "close")
    response.end("ok")
  })
  let connections = 0
  receiver.on("connection", () => connections++)
  await new Promise(resolve => receiver.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise(resolve => receiver.close(resolve)))
  const probe = await fixture(t)
  const result = await probe.run(`
import http from "node:http"
const wrapped=http.get
const get=()=>new Promise((resolve,reject)=>http.get("http://127.0.0.1:${receiver.address().port}/allowed",response=>{let body="";response.on("data",chunk=>body+=chunk);response.on("end",()=>resolve(body))}).on("error",reject))
assert.equal(await get(),"ok")
handle.dispose()
assert.equal(http.get,wrapped)
assert.throws(()=>{http.get=()=>"replacement"},{code:"ERR_GUARD_SELF_PROTECTION"})
assert.equal(http.get,wrapped)
assert.equal(await get(),"ok")
process.send({type:"result",result:true},()=>process.disconnect())
`)
  assert.equal(connections, 2)
  const events = result.events.filter(value => value.operation === "http.get")
  assert.equal(events.length, 1)
  assert.equal(events[0].action, "audit")
  assert.equal(events[0].details.blocked, false)
})

test("native instrumentation hooks are refused even under an explicit audit rule", async t => {
  const probe = await fixture(t, {
    protect: { enabled: true, intervalMs: 10, action: "deny" },
    rules: [
      {
        id: "observe-self-protection",
        kind: "self-protection",
        plugin: pluginId,
        target: "http.get",
        action: "audit",
      },
    ],
  })
  const result = await probe.run(`
import http from "node:http"
const wrapped=http.get
assert.throws(()=>{http.get=()=>"local-replacement"},{code:"ERR_GUARD_SELF_PROTECTION"})
assert.equal(http.get,wrapped)
handle.dispose()
assert.equal(http.get,wrapped)
process.send({type:"result",result:true},()=>process.disconnect())
`)
  const event = result.events.find(
    value => value.target === "http.get" && value.kind === "self-protection",
  )
  assert.equal(event.plugin, pluginId)
  assert.equal(event.action, "deny")
  assert.equal(event.ruleId, undefined)
  assert.equal(event.details.detection, "before-call")
  assert.equal(event.details.blocked, true)
})

test("Worker constructor hooks are refused inside a Worker with full native attribution", async t => {
  const probe = await fixture(t, {
    protect: { enabled: true, intervalMs: 10, action: "deny" },
    rules: [
      {
        id: "own-worker-integrity",
        kind: "integrity",
        plugin: pluginId,
        target: "worker_threads.Worker",
        action: "restart",
      },
    ],
  })
  const worker = `import assert from"node:assert/strict";import workerThreads from"node:worker_threads";
const original=workerThreads.Worker;assert.throws(()=>{workerThreads.Worker=class LocalReplacement{}},{code:"ERR_GUARD_SELF_PROTECTION"});assert.equal(workerThreads.Worker,original);
await new Promise(resolve=>setTimeout(resolve,50));workerThreads.parentPort.postMessage({done:true});`
  const result = await probe.run(`
import { Worker } from "node:worker_threads"
const worker=new Worker(${JSON.stringify(worker)},{eval:true})
let completed=false;worker.once("message",value=>{completed=value.done===true})
await new Promise((resolve,reject)=>{worker.once("error",reject);worker.once("exit",code=>code?reject(Error("worker failed")):resolve())})
assert.equal(completed,true)
handle.dispose()
process.send({type:"result",result:true},()=>process.disconnect())
`)
  const event = result.events.find(
    value => value.kind === "self-protection" && value.target === "worker_threads.Worker",
  )
  assert.ok(event)
  assert.equal(event.plugin, pluginId)
  assert.equal(event.action, "deny")
  assert.equal(event.details.blocked, true)
  assert.equal(event.details.runtime.kind, "thread")
})
