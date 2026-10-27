import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { randomBytes, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseSettings } from "../dist/config/index.js"
import { isDirectNodeLaunch } from "../dist/runtime/launch.js"

test("exact running executable stays recognizable when AppContainer denies metadata traversal", () => {
  const previous = fs.realpathSync.native
  let metadataCalls = 0
  fs.realpathSync.native = () => {
    metadataCalls++
    throw Object.assign(new Error("Denied metadata traversal"), { code: "EPERM" })
  }
  try {
    assert.equal(isDirectNodeLaunch("spawn", [process.execPath, ["-e", "0"]]), true)
    assert.equal(isDirectNodeLaunch("fork", ["app.mjs", [], { execPath: process.execPath }]), true)
    assert.equal(metadataCalls, 0, "known executable requires no ancestor filesystem lookup")
    const other = path.join(
      path.dirname(process.execPath),
      "different-runtime",
      path.basename(process.execPath),
    )
    assert.equal(isDirectNodeLaunch("spawn", [other, ["-e", "0"]]), false)
    assert.equal(isDirectNodeLaunch("fork", ["app.mjs", [], { execPath: other }]), false)
  } finally {
    fs.realpathSync.native = previous
  }
})

async function fixture(settings = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "guard runtime "))
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\guard-test-${randomUUID()}`
      : path.join(directory, "broker.sock")
  const records = []
  const connections = new Set()
  const server = net.createServer(socket => {
    const channelNonce = randomBytes(24).toString("hex")
    connections.add(socket)
    socket.on("close", () => connections.delete(socket))
    socket.on("error", () => {})
    let input = ""
    socket.on("data", chunk => {
      input += chunk
      let newline
      while ((newline = input.indexOf("\n")) >= 0) {
        const message = JSON.parse(input.slice(0, newline))
        input = input.slice(newline + 1)
        records.push(message)
        if (message.type === "runtime-hello")
          socket.write(
            JSON.stringify({
              type: "runtime-ready",
              runtimeId: message.runtimeId,
              auditProtocol: 1,
              generation: 1,
              channelNonce,
            }) + "\n",
          )
        else if (message.auditProtocol === 1 && ["audit", "violation"].includes(message.type))
          socket.write(
            JSON.stringify({
              type: "audit-hop-ack",
              auditProtocol: 1,
              generation: 1,
              channelNonce,
              auditSeq: message.auditSeq,
              result: "received",
            }) + "\n",
          )
      }
    })
  })
  await new Promise((resolve, reject) => server.listen(endpoint, resolve).once("error", reject))
  const manifest = path.join(directory, "manifest.json")
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      version: 1,
      generation: 1,
      projectId: "test",
      token: "test-token-at-least-16-characters",
      endpoint,
      settings: parseSettings(settings),
    }),
  )
  const launch = async (source, extraEnv = {}) => {
    const main = path.join(directory, `${randomUUID()}.mjs`)
    fs.writeFileSync(main, source)
    const env = {
      ...process.env,
      ...extraEnv,
      YUNZAI_GUARD_RUNTIME_MANIFEST: manifest,
      YUNZAI_GUARD_ORIGIN_PLUGIN: "runtime-probe",
    }
    delete env.NODE_OPTIONS
    const child = spawn(
      process.execPath,
      [
        ...(process.platform === "win32"
          ? ["--preserve-symlinks", "--preserve-symlinks-main"]
          : []),
        "--require",
        fileURLToPath(new URL("../dist/runtime-bootstrap.cjs", import.meta.url)),
        "--import",
        new URL("../dist/child-preload.js", import.meta.url).href,
        main,
      ],
      { env, cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
    )
    let stderr = "",
      stdout = ""
    child.stderr.on("data", chunk => {
      stderr += chunk
    })
    child.stdout.on("data", chunk => {
      stdout += chunk
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000)
    timer.unref()
    try {
      const [code] = await once(child, "exit")
      assert.equal(code, 0, stderr)
      return { stdout, stderr }
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    }
  }
  return {
    directory,
    records,
    launch,
    async close() {
      for (const socket of connections) socket.destroy()
      await new Promise(resolve => server.close(resolve))
      assert.equal(
        path.dirname(fs.realpathSync.native(directory)),
        fs.realpathSync.native(os.tmpdir()),
      )
      fs.rmSync(directory, { recursive: true, force: true })
    },
  }
}

test("fork and synchronous direct Node descendants propagate monitoring without polluting application IPC", async () => {
  const probe = await fixture()
  try {
    const marker = path.join(probe.directory, "fork-marker.json")
    const childModule = path.join(probe.directory, "business-child.mjs")
    const userPreload = path.join(probe.directory, "user-preload.cjs")
    const envPreload = path.join(probe.directory, "node-options-preload.cjs")
    fs.writeFileSync(
      userPreload,
      'globalThis.userPreload=true;require("node:child_process").execFileSync(process.execPath,["--version"])\n',
    )
    fs.writeFileSync(
      envPreload,
      'globalThis.guardDuringNodeOptions=Boolean(globalThis[Symbol.for("yunzai.guard.runtime.v1")])\n',
    )
    fs.writeFileSync(
      childModule,
      `import fs from "node:fs";import{execFileSync}from"node:child_process";const nested=execFileSync(process.execPath,["-p","Boolean(globalThis[Symbol.for('yunzai.guard.runtime.v1')])"],{encoding:"utf8"}).trim();fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({guard:Boolean(globalThis[Symbol.for("yunzai.guard.runtime.v1")]),preload:globalThis.userPreload,nodeOptions:globalThis.guardDuringNodeOptions,nested}));process.send({business:true});\n`,
    )
    await probe.launch(
      `import{fork,execFile}from"node:child_process";const direct=await new Promise((resolve,reject)=>execFile(process.execPath,["-p","Boolean(globalThis[Symbol.for('yunzai.guard.runtime.v1')])"],(error,stdout)=>error?reject(error):resolve(stdout)));if(direct.trim()!=="true")throw Error("callback execFile escaped monitoring");const child=fork(${JSON.stringify(childModule)},[],{execArgv:["--require",${JSON.stringify(userPreload)}],env:{...process.env,NODE_OPTIONS:${JSON.stringify(`--require ${JSON.stringify(envPreload)}`)}},silent:true});let business=0;child.on("message",message=>{if(!message.business)throw Error("Guard polluted app IPC");business++});child.on("exit",code=>{if(code!==0||business!==1)process.exit(2)});`,
    )
    const result = JSON.parse(fs.readFileSync(marker, "utf8"))
    assert.deepEqual(result, { guard: true, preload: true, nodeOptions: true, nested: "true" })
    assert.ok(probe.records.filter(record => record.type === "runtime-hello").length >= 3)
    assert.ok(
      probe.records.some(
        record =>
          record.event?.operation === "execFileSync" && record.event?.plugin === "runtime-probe",
      ),
    )
  } finally {
    await probe.close()
  }
})

test("nested Workers preserve application transfers and report a blocked internal operation", async () => {
  const probe = await fixture({
    audit: { maxQueue: 1 },
    rules: [
      { id: "no-worker-exec", kind: "process", operation: "execFileSync", action: "restart" },
    ],
  })
  try {
    const marker = path.join(probe.directory, "must-not-exist")
    const requirePreload = path.join(probe.directory, "worker-user.cjs")
    const importPreload = path.join(probe.directory, "worker-user.mjs")
    fs.writeFileSync(requirePreload, 'globalThis.workerPreloadOrder=["require"]\n')
    fs.writeFileSync(importPreload, 'globalThis.workerPreloadOrder.push("import")\n')
    const inner = `import{parentPort,workerData}from"node:worker_threads";import{execFileSync}from"node:child_process";let code;try{execFileSync(process.execPath,["-e",${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`)}])}catch(error){code=error.code}parentPort.postMessage({code,data:workerData.tag,payload:new Uint8Array(workerData.buffer)[0],guard:Boolean(globalThis[Symbol.for("yunzai.guard.runtime.v1")])});`
    const outer = `import{Worker,parentPort,workerData}from"node:worker_threads";if(globalThis.workerPreloadOrder.join(",")!=="require,import")throw Error("preload order changed");const worker=new Worker(${JSON.stringify(inner)},{eval:true,execArgv:[],workerData:{tag:workerData.tag,buffer:workerData.buffer},transferList:[workerData.buffer]});worker.on("message",message=>parentPort.postMessage(message));worker.on("error",error=>{throw error});`
    const result = await probe.launch(
      `import{Worker}from"node:worker_threads";const buffer=new ArrayBuffer(4);new Uint8Array(buffer)[0]=37;const worker=new Worker(${JSON.stringify(outer)},{eval:true,execArgv:["--require",${JSON.stringify(requirePreload)},"--import",${JSON.stringify(pathToFileURL(importPreload).href)}],workerData:{tag:"unchanged",buffer},transferList:[buffer]});if(buffer.byteLength!==0)throw Error("transfer semantics changed");worker.on("message",message=>console.log(JSON.stringify(message)));worker.on("error",error=>{throw error});`,
    )
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      code: "GUARD_DENIED",
      data: "unchanged",
      payload: 37,
      guard: true,
    })
    assert.equal(fs.existsSync(marker), false)
    // 业务 Worker 消息与私有审计异步转发相互独立；等待 Worker 自然退出后，再等待 broker 的目标记录。
    const deadline = Date.now() + 3000
    let violation
    do {
      violation = probe.records.find(
        record => record.type === "violation" && record.event?.ruleId === "no-worker-exec",
      )
      if (violation) break
      await new Promise(resolve => setTimeout(resolve, 5))
    } while (Date.now() < deadline)
    assert.ok(violation, "nested violation reached the independent host broker")
    assert.equal(violation.event.details.runtime.kind, "thread")
    // maxQueue=1 可能在前一条记录传输时拒绝普通生命周期记录；此用例验证关键消息交付，普通转发由 runtime-observation 的默认配额用例覆盖。
  } finally {
    await probe.close()
  }
})

test("fork runtime blocks network requests before the external receiver sees a connection", async () => {
  const probe = await fixture({
    rules: [{ id: "no-child-network", kind: "network", action: "restart" }],
  })
  const receiver = net.createServer(socket => socket.destroy())
  let connections = 0
  receiver.on("connection", () => {
    connections++
  })
  await new Promise(resolve => receiver.listen(0, "127.0.0.1", resolve))
  try {
    const childModule = path.join(probe.directory, "network-child.mjs")
    fs.writeFileSync(
      childModule,
      `import http from"node:http";let code;try{http.get("http://127.0.0.1:${receiver.address().port}/blocked?token=hidden")}catch(error){code=error.code}process.send({code});`,
    )
    const output = await probe.launch(
      `import{fork}from"node:child_process";const child=fork(${JSON.stringify(childModule)},[],{execArgv:[],silent:true});child.on("message",message=>console.log(JSON.stringify(message)));child.on("exit",code=>{if(code!==0)process.exit(2)});`,
    )
    assert.equal(JSON.parse(output.stdout.trim()).code, "GUARD_DENIED")
    assert.equal(connections, 0)
    assert.ok(
      probe.records.some(
        record => record.type === "violation" && record.event?.ruleId === "no-child-network",
      ),
    )
    assert.equal(JSON.stringify(probe.records).includes("token=hidden"), false)
  } finally {
    await new Promise(resolve => receiver.close(resolve))
    await probe.close()
  }
})

test("direct Node propagation works with an empty caller environment and required Windows resolution flags", async () => {
  const probe = await fixture()
  try {
    const expression =
      'JSON.stringify({guard:Boolean(globalThis[Symbol.for("yunzai.guard.runtime.v1")]),flags:process.execArgv.filter(value=>value.startsWith("--preserve-symlinks"))})'
    const output = await probe.launch(
      `import{execFileSync}from"node:child_process";process.stdout.write(execFileSync(process.execPath,["-p",${JSON.stringify(expression)}],{env:{},encoding:"utf8"}));`,
    )
    const result = JSON.parse(output.stdout.trim())
    assert.equal(result.guard, true)
    if (process.platform === "win32")
      assert.deepEqual(
        new Set(result.flags),
        new Set(["--preserve-symlinks", "--preserve-symlinks-main"]),
      )
  } finally {
    await probe.close()
  }
})
