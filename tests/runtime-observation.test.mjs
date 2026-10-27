import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once, EventEmitter } from "node:events"
import threads, { Worker, MessageChannel } from "node:worker_threads"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { parseSettings } from "../dist/config/index.js"
import { runtimeEventDecision, runtimeFailureDecision } from "../dist/runtime/policy.js"
import { installWorkerMonitor, workerMetadataKey } from "../dist/runtime/worker-monitor.js"

const identity = {
  id: "observation-test",
  kind: "yunzai",
  generation: 1,
  pid: process.pid,
  originPlugin: "example",
  observability: "js-entrypoints",
}
const failure = {
  kind: "runtime",
  operation: "runtime-bootstrap-failed",
  target: "child",
  plugin: "example",
}

test("runtime failures default to audit and scope enforcing policy to the current plugin", () => {
  assert.deepEqual(runtimeFailureDecision(parseSettings({}), failure), { action: "audit" })
  const rule = { id: "deny-network", kind: "network", plugin: "other", action: "deny" }
  assert.deepEqual(runtimeFailureDecision(parseSettings({ rules: [rule] }), failure), {
    action: "audit",
  })
  rule.plugin = "example"
  assert.deepEqual(runtimeFailureDecision(parseSettings({ rules: [rule] }), failure), {
    action: "deny",
  })
  rule.action = "restart"
  assert.deepEqual(runtimeFailureDecision(parseSettings({ rules: [rule] }), failure), {
    action: "restart",
  })
  assert.deepEqual(
    runtimeFailureDecision(
      parseSettings({
        rules: [
          {
            id: "optional-telemetry",
            kind: "runtime",
            operation: failure.operation,
            action: "audit",
          },
          rule,
        ],
      }),
      failure,
    ),
    { action: "audit", ruleId: "optional-telemetry" },
  )
  assert.deepEqual(
    runtimeFailureDecision(parseSettings({ protect: { action: "restart" } }), failure),
    { action: "restart" },
  )
  assert.deepEqual(
    runtimeFailureDecision(
      parseSettings({ protect: { enabled: false, action: "restart" } }),
      failure,
    ),
    { action: "audit" },
  )
})

test("runtime event labels cannot grant restart and reported rules must match current authority", () => {
  assert.deepEqual(runtimeEventDecision(parseSettings({}), { ...failure, action: "restart" }), {
    action: "audit",
  })
  const settings = parseSettings({
    rules: [
      {
        id: "shell",
        kind: "process",
        plugin: "example",
        operation: "exec",
        target: "example-command --secret=*",
        action: "restart",
      },
    ],
  })
  const event = {
    kind: "process",
    operation: "exec",
    target: "example-command",
    plugin: "example",
    ruleId: "shell",
    action: "restart",
    details: { argumentsRedacted: true },
  }
  assert.deepEqual(runtimeEventDecision(settings, event), { action: "restart", ruleId: "shell" })
  for (const change of [
    { plugin: "other" },
    { operation: "spawn" },
    { kind: "network" },
    { action: "deny" },
    { ruleId: "missing" },
    { details: {} },
  ])
    assert.deepEqual(runtimeEventDecision(settings, { ...event, ...change }), { action: "audit" })
  const integrity = parseSettings({ protect: { action: "restart" } })
  assert.deepEqual(
    runtimeEventDecision(integrity, {
      kind: "integrity",
      operation: "protected-target-change",
      target: "PluginsLoader.filtPermission",
    }),
    { action: "restart" },
  )
  assert.deepEqual(
    runtimeEventDecision(integrity, {
      kind: "integrity",
      operation: "protected-target-change",
      target: "Other.fn",
    }),
    { action: "audit" },
  )
})

test("redacted shell reports preserve first-match precedence and cannot suppress known enforcement", () => {
  const reported = {
    kind: "process",
    operation: "execSync",
    target: "forbidden-command",
    plugin: "example",
    action: "restart",
    ruleId: "later",
    details: { argumentsRedacted: true },
  }
  const later = {
    id: "later",
    kind: "process",
    operation: "execSync",
    target: "forbidden-command --secret=*",
    action: "restart",
  }
  for (const target of [undefined, "*", "forbidden-command"]) {
    const earlier = {
      id: "earlier",
      kind: "process",
      operation: "execSync",
      action: "audit",
      ...(target ? { target } : {}),
    }
    assert.deepEqual(runtimeEventDecision(parseSettings({ rules: [earlier, later] }), reported), {
      action: "audit",
      ruleId: "earlier",
    })
  }
  const enforcing = parseSettings({ rules: [{ id: "global", kind: "process", action: "deny" }] })
  for (const ruleId of ["missing", undefined])
    assert.deepEqual(runtimeEventDecision(enforcing, { ...reported, ruleId, action: "audit" }), {
      action: "deny",
      ruleId: "global",
    })
})

async function socketCase(mode, inputSettings = {}, expected = 0) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "guard-observe-"))
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\guard-observe-${randomUUID()}`
      : path.join(directory, "broker.sock")
  const sockets = new Set()
  const server =
    mode === "missing"
      ? undefined
      : net.createServer(socket => {
          sockets.add(socket)
          socket.on("error", () => {})
          socket.on("close", () => sockets.delete(socket))
          if (mode === "timeout") return
          if (mode === "invalid") {
            socket.write("null\n")
            return
          }
          let input = ""
          socket.on("data", bytes => {
            input += bytes
            const newline = input.indexOf("\n")
            if (newline < 0) return
            const value = JSON.parse(input.slice(0, newline))
            if (value.type !== "runtime-hello") return
            socket.write(
              JSON.stringify({
                type: "runtime-ready",
                runtimeId: value.runtimeId,
                auditProtocol: 1,
                generation: 1,
                channelNonce: "b".repeat(48),
              }) + "\n",
            )
            socket.removeAllListeners("data")
            setTimeout(() => socket.destroy(), 20)
          })
        })
  if (server)
    await new Promise((resolve, reject) => server.listen(endpoint, resolve).once("error", reject))
  const manifest = path.join(directory, "manifest.json")
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      version: 1,
      generation: 1,
      projectId: "observation",
      endpoint,
      token: "test-observation-token",
      settings: parseSettings({ handshakeTimeout: 100, ...inputSettings }),
    }),
  )
  const env = {
    ...process.env,
    YUNZAI_GUARD_RUNTIME_MANIFEST: manifest,
    YUNZAI_GUARD_ORIGIN_PLUGIN: "example",
  }
  delete env.NODE_OPTIONS
  const child = spawn(
    process.execPath,
    [
      "--require",
      fileURLToPath(new URL("../dist/runtime-bootstrap.cjs", import.meta.url)),
      "--import",
      new URL("../dist/child-preload.js", import.meta.url).href,
      "--input-type=module",
      "--eval",
      'await new Promise(r=>setTimeout(r,150));console.log("application-continued")',
    ],
    { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  )
  let stdout = "",
    stderr = ""
  child.stdout.on("data", bytes => (stdout += bytes))
  child.stderr.on("data", bytes => (stderr += bytes))
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000)
  try {
    const [code] = await once(child, "exit")
    assert.equal(code, expected, stderr)
    assert.equal(stdout.includes("application-continued"), expected === 0)
    assert.match(stderr, /runtime monitoring degraded/)
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    for (const socket of sockets) socket.destroy()
    if (server) await new Promise(resolve => server.close(resolve))
    assert.equal(
      path.dirname(fs.realpathSync.native(directory)),
      fs.realpathSync.native(os.tmpdir()),
    )
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test(
  "default audit Node applications continue when telemetry is absent, late, or disconnected",
  { timeout: 30000 },
  async () => {
    for (const mode of ["missing", "timeout", "disconnect", "invalid"]) await socketCase(mode)
  },
)
test(
  "matching enforcement still fails closed, while unrelated rules and explicit runtime audit continue",
  { timeout: 30000 },
  async () => {
    const rule = { id: "deny-network", kind: "network", plugin: "example", action: "deny" }
    await socketCase("missing", { rules: [rule] }, 1)
    await socketCase("missing", { rules: [{ ...rule, plugin: "other" }] })
    await socketCase("missing", {
      rules: [
        { id: "telemetry", kind: "runtime", operation: failure.operation, action: "audit" },
        rule,
      ],
    })
  },
)

test(
  "closing a real Worker private telemetry port preserves its business messages in default audit",
  { timeout: 20000 },
  async () => {
    for (const enforcing of [false, true]) {
      const { port1, port2 } = new MessageChannel()
      const settings = parseSettings(
        enforcing ? { rules: [{ id: "deny", kind: "network", action: "deny" }] } : {},
      )
      const code = `const {workerData,parentPort,setEnvironmentData}=require('node:worker_threads');(async()=>{const {workerMetadataKey}=await import(${JSON.stringify(new URL("../dist/runtime/worker-monitor.js", import.meta.url).href)});setEnvironmentData(workerMetadataKey,{version:1,identity:{id:'port-close',kind:'thread',generation:1,pid:process.pid,originPlugin:'example',observability:'js-entrypoints'},settings:workerData.settings,port:workerData.port,auditChannelNonce:'${"b".repeat(48)}'});const {installInheritedRuntime}=await import(${JSON.stringify(new URL("../dist/runtime/index.js", import.meta.url).href)});installInheritedRuntime();setTimeout(()=>parentPort.postMessage('business-alive'),150)})()`
      const worker = new Worker(code, {
        eval: true,
        execArgv: [],
        workerData: { port: port2, settings },
        transferList: [port2],
      })
      const messages = []
      worker.on("message", message => messages.push(message))
      const exit = once(worker, "exit")
      const timer = setTimeout(() => void worker.terminate(), 10000)
      try {
        await once(port1, "message")
        port1.close()
        assert.equal((await exit)[0], enforcing ? 1 : 0)
        assert.deepEqual(messages, enforcing ? [] : ["business-alive"])
      } finally {
        clearTimeout(timer)
        port1.close()
        await worker.terminate()
      }
    }
  },
)

test(
  "Worker bootstrap timeout only terminates under applicable enforcement, and audit failures are harmless",
  { timeout: 10000 },
  async () => {
    class FakeWorker extends EventEmitter {
      threadId = 42
      terminated = false
      constructor(filename, options) {
        super()
        this.options = options
        this.metadata = threads.getEnvironmentData(workerMetadataKey)
      }
      terminate() {
        this.terminated = true
        return Promise.resolve(0)
      }
    }
    const original = Object.getOwnPropertyDescriptor(threads, "Worker")
    try {
      for (const enforcing of [false, true]) {
        Object.defineProperty(threads, "Worker", { ...original, value: FakeWorker })
        const events = []
        let registered
        const registration = new Promise(resolve => {
          registered = resolve
        })
        const settings = parseSettings({
          handshakeTimeout: 100,
          ...(enforcing
            ? { rules: [{ id: "deny", kind: "network", plugin: "example", action: "deny" }] }
            : {}),
        })
        const dispose = installWorkerMonitor({
          settings,
          identity,
          originPlugin: () => "example",
          emit: event => {
            events.push(event)
            if (event.operation === "worker-runtime-registered") registered(event)
            if (event.operation === "worker") throw Error("optional sink unavailable")
          },
        })
        const worker = new threads.Worker("fixture.js")
        const port = worker.options.transferList.at(-1)
        const replies = []
        port.on("message", frame => replies.push(frame))
        for (const [index, action] of [undefined, "invalid-action"].entries())
          port.postMessage({
            type: "audit",
            auditProtocol: 1,
            generation: 1,
            channelNonce: worker.metadata.auditChannelNonce,
            auditSeq: index + 1,
            event: {
              kind: "guard",
              operation: action === undefined ? "instrumentation-installed" : "invalid-action",
              target: "builtin-js-entrypoints",
              ...(action === undefined ? {} : { action }),
            },
          })
        try {
          await new Promise(resolve => setTimeout(resolve, 150))
          assert.deepEqual(
            replies.map(frame => frame.result),
            ["received", "rejected-frame"],
            "a missing action is valid while an explicit illegal action is rejected",
          )
          assert.equal(
            events.find(event => event.operation === "instrumentation-installed")?.action,
            "audit",
          )
          assert.equal(
            events.some(event => event.operation === "invalid-action"),
            false,
          )
          assert.equal(worker.terminated, enforcing)
          assert.equal(
            events.find(event => event.operation === failure.operation).action,
            enforcing ? "deny" : "audit",
          )
          if (!enforcing) {
            port.postMessage({
              type: "runtime-ready",
              auditProtocol: 1,
              generation: 1,
              channelNonce: worker.metadata.auditChannelNonce,
            })
            assert.equal((await registration).operation, "worker-runtime-registered")
          }
        } finally {
          dispose()
          worker.emit("exit", 0)
          port.close()
        }
        if (!enforcing) assert.ok(events.some(event => event.operation === "worker-runtime-exited"))
      }
    } finally {
      Object.defineProperty(threads, "Worker", original)
    }
  },
)
