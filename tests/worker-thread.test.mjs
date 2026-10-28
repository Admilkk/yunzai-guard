import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"

for (const variant of [
  ...[undefined, null, false, "", 0].map(execArgv => ({
    name: `execArgv=${JSON.stringify(execArgv)}`,
    argv: JSON.stringify(execArgv) ?? "undefined",
  })),
  { name: "array options", argv: "[]", kind: "array" },
  { name: "function options", argv: "[]", kind: "function" },
  { name: "proxy options", argv: "[]", kind: "proxy" },
  {
    name: "coercible execArgv entry",
    argv: '[{toString(){coercionReads++;return "--no-deprecation"}}]',
    coercions: 1,
    noDeprecation: true,
  },
  { name: "ignored execArgv entries", argv: '[null,0,false,undefined,,"--no-deprecation"]' },
])
  test(`real CLI preloading preserves Worker options and monitoring (${variant.name})`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yunzai-guard-thread-"))
    const main = path.join(directory, "main.mjs")
    const preload = new URL("../dist/worker-preload.js", import.meta.url).href
    fs.writeFileSync(
      main,
      `
import assert from "node:assert/strict"
import { Worker, getEnvironmentData, setEnvironmentData } from "node:worker_threads"
const mainManaged = Boolean(globalThis[Symbol.for("yunzai.guard.context.v1")])
assert.equal(Worker.prototype.constructor, Worker)
const metadataKey="yunzai.guard.runtime.bootstrap.v1"
assert.equal(getEnvironmentData(metadataKey),undefined)
assert.throws(()=>setEnvironmentData(metadataKey,{}),{code:"ERR_GUARD_SELF_PROTECTION"})
setEnvironmentData("business-data",42)
class BusinessWorker extends Worker.prototype.constructor {}
let evalReads=0
let coercionReads=0
const options=${variant.kind === "array" ? "[]" : variant.kind === "function" ? "(function workerOptions(){})" : variant.kind === "proxy" ? "new Proxy(Object.create(null),{})" : "Object.create(null)"}
Object.setPrototypeOf(options,{get eval(){evalReads++;return true},execArgv:${variant.argv}})
Object.defineProperty(options,"workerData",{value:"non-enumerable"})
const isArray=Array.isArray
Array.isArray=()=>false
const worker = new BusinessWorker(\`
  import { parentPort, getEnvironmentData, workerData } from "node:worker_threads"
  parentPort.postMessage({
    threadManaged: Boolean(globalThis[Symbol.for("yunzai.guard.context.v1")]),
    threadInstrumented: Boolean(globalThis[Symbol.for("yunzai.guard.runtime.v1")]),
    inheritedArgv: process.execArgv,
    executed: true,
    businessData: getEnvironmentData("business-data"),
    workerData,
    noDeprecation: Boolean(process.noDeprecation),
  })
\`, options)
Array.isArray=isArray
assert.equal(evalReads,1)
assert.equal(coercionReads,${variant.coercions ?? 0})
assert.ok(worker instanceof Worker && worker instanceof BusinessWorker)
worker.on("error", error => { console.error(error); process.exit(1) })
worker.on("message", result => {
  process.send({ type: "thread-test-result", mainManaged, ...result }, () => process.exit(0))
})
`,
      "utf8",
    )
    const env = { ...process.env }
    delete env.NODE_OPTIONS
    const child = spawn(process.execPath, ["--import", preload, main], {
      cwd: directory,
      env,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    })
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 10000)
    watchdog.unref()
    let result
    let stderr = ""
    child.stderr.on("data", chunk => {
      stderr += chunk
    })
    child.on("message", message => {
      if (message.type === "preload-hello")
        child.send({
          type: "worker-handshake",
          nonce: message.nonce,
          projectId: message.projectId,
          generation: 1,
          settings: {},
          auditChannelNonce: "c".repeat(48),
          controlKey: "a".repeat(64),
        })
      if (message.auditProtocol === 1 && ["audit", "violation"].includes(message.type))
        child.send({
          type: "audit-hop-ack",
          auditProtocol: 1,
          generation: 1,
          channelNonce: "c".repeat(48),
          auditSeq: message.auditSeq,
          result: "received",
        })
      if (message.type === "thread-test-result") result = message
    })
    try {
      const [code] = await once(child, "exit")
      assert.equal(code, 0, stderr)
      assert.ok(result?.executed, "Worker script executed after inherited preloading")
      assert.equal(result.mainManaged, true, "main thread retains its managed context")
      assert.equal(
        result.threadManaged,
        false,
        "ordinary Worker is not falsely reported as a Yunzai instance",
      )
      assert.equal(result.threadInstrumented, true, "Worker API calls inherit monitoring")
      assert.equal(result.businessData, 42)
      assert.equal(result.workerData, "non-enumerable")
      assert.equal(result.noDeprecation, variant.noDeprecation ?? false)
      assert.ok(
        result.inheritedArgv.some(value => value.endsWith("child-preload.js")),
        "uses guarded runtime preloading",
      )
    } finally {
      clearTimeout(watchdog)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()))
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
