import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"
import {
  createWorkerTransportCounters,
  workerTransportStats,
  writeWorkerControlFrame,
  workerTransportIsIncomplete,
} from "../dist/runtime/worker-transport.js"

function fixture() {
  const callbacks = [],
    writes = []
  return {
    callbacks,
    writes,
    writable: true,
    destroyed: false,
    writableLength: 0,
    write(message, callback) {
      writes.push(message)
      callbacks.push(callback)
      return false
    },
  }
}
test("Windows Worker control bridge preserves accepted false/callback and counts only its transport boundary", () => {
  assert.equal(workerTransportStats(), undefined)
  const socket = fixture(),
    counters = createWorkerTransportCounters(),
    completed = []
  assert.equal(
    writeWorkerControlFrame(socket, true, { type: "business", payload: "中文" }, counters, error =>
      completed.push(error),
    ),
    false,
  )
  assert.equal(completed.length, 0)
  socket.callbacks[0](null)
  socket.callbacks[0](new Error("duplicate callback"))
  assert.deepEqual(completed, [null])
  assert.equal(counters.accepted, 1)
  assert.equal(counters.completed, 1)
  assert.equal(counters.unknown, 0)
  assert.equal(counters.provenance, "guest-reported")
})
test("Windows Worker control bridge refuses actual queue overflow, UTF8/escaped oversize and disconnected sends before write", () => {
  const socket = fixture(),
    counters = createWorkerTransportCounters(),
    errors = []
  const message = { type: "business" },
    bytes = Buffer.byteLength(JSON.stringify(message) + "\n")
  socket.writableLength = 256 * 1024 - bytes
  assert.equal(writeWorkerControlFrame(socket, true, message, counters), false)
  socket.writableLength++
  assert.equal(
    writeWorkerControlFrame(socket, true, message, counters, error => errors.push(error)),
    false,
  )
  assert.match(errors[0].message, /沙箱控制队列超过 256 KiB/)
  socket.writableLength = 0
  assert.throws(
    () => writeWorkerControlFrame(socket, true, { text: "中".repeat(22000) }, counters),
    /64 KiB/,
  )
  assert.throws(
    () => writeWorkerControlFrame(socket, true, { text: "\0".repeat(11000) }, counters),
    /64 KiB/,
  )
  assert.equal(
    writeWorkerControlFrame(socket, false, message, counters, error => errors.push(error)),
    false,
  )
  assert.match(errors[1].message, /沙箱控制管道已断开/)
  assert.equal(socket.writes.length, 1)
  assert.equal(counters.rejected, 4)
  assert.equal(counters.closed, 1)
})
test("Windows Worker control bridge records real callback/synchronous failures once without claiming append", () => {
  const socket = fixture(),
    counters = createWorkerTransportCounters(),
    errors = []
  writeWorkerControlFrame(socket, true, {}, counters, error => errors.push(error))
  socket.callbacks[0](new Error("native write failed"))
  socket.callbacks[0](new Error("duplicate"))
  socket.write = () => {
    throw new Error("native synchronous failure")
  }
  assert.throws(() => writeWorkerControlFrame(socket, true, {}, counters), /synchronous/)
  assert.equal(errors.length, 1)
  assert.equal(counters.completed, 0)
  assert.equal(counters.unknown, 2)
  assert.equal(counters.evidence, "transport-callback-only")
})

test("bridge losses and pending callbacks affect only coverage, never audit-record counters", () => {
  const counters = createWorkerTransportCounters()
  assert.equal(workerTransportIsIncomplete(counters), false)
  for (const field of ["rejected", "unknown", "closed", "accepted"]) {
    const changed = { ...counters, [field]: 1 }
    assert.equal(workerTransportIsIncomplete(changed), true)
  }
  assert.equal(
    workerTransportIsIncomplete({ ...counters, offered: 2, accepted: 2, completed: 2 }),
    false,
  )
})

test(
  "self-authored Windows control bridge reports a refused business frame before seal without changing its native exit",
  { skip: process.platform !== "win32", timeout: 15000 },
  async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yunzai-guard-native-bridge-seal-"))
    const endpoint = `\\\\.\\pipe\\yunzai-guard-${randomBytes(16).toString("hex")}`
    const channelNonce = randomBytes(24).toString("hex"),
      closeNonce = randomBytes(24).toString("hex")
    const frames = [],
      seals = []
    let connection, child
    const server = net.createServer(socket => {
      connection = socket
      socket.setEncoding("utf8")
      socket.on("error", () => {})
      let input = ""
      const send = frame => socket.write(JSON.stringify(frame) + "\n")
      socket.on("data", chunk => {
        input += chunk
        while (input.includes("\n")) {
          const newline = input.indexOf("\n"),
            frame = JSON.parse(input.slice(0, newline))
          input = input.slice(newline + 1)
          if (frame.type === "preload-hello")
            send({
              type: "worker-handshake",
              nonce: frame.nonce,
              projectId: frame.projectId,
              generation: 1,
              auditChannelNonce: channelNonce,
              controlKey: "a".repeat(64),
              settings: { shutdownTimeout: 1000, protect: { enabled: false, targets: [] } },
              sandboxSources: [],
            })
          else if (frame.type === "business-probe-ready") {
            send({
              type: "audit-prepare-flush",
              auditProtocol: 1,
              generation: 1,
              channelNonce,
              closeNonce,
              remainingBudgetMs: 1000,
              scope: "this-source-only",
            })
            send({ type: "shutdown", generation: 1 })
          } else if (frame.type === "audit" || frame.type === "violation") {
            fs.appendFileSync(path.join(root, "host-appended.jsonl"), JSON.stringify(frame) + "\n")
            frames.push(frame)
            send({
              type: "audit-hop-ack",
              auditProtocol: 1,
              generation: 1,
              channelNonce,
              auditSeq: frame.auditSeq,
              result: "received",
            })
          } else if (frame.type === "audit-seal") {
            seals.push(frame)
            send({
              type: "audit-flush-result",
              auditProtocol: 1,
              generation: 1,
              channelNonce,
              closeNonce,
              cutoff: frame.lastSentSeq,
              scope: "this-source-only",
              outcome: "incomplete",
              receivedThrough: frames.length,
              settledThrough: frames.length,
              writtenThrough: frames.length,
              writtenCount: frames.length,
              rejectedCount: 0,
              unknownCount: 0,
              remainingCount: 0,
              evidence: "host-append-completed",
            })
          }
        }
      })
    })
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(endpoint, resolve)
    })
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      connection?.destroy()
      await new Promise(resolve => server.close(resolve))
      fs.rmSync(root, { recursive: true, force: true })
    })
    const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
    const env = { ...process.env, YUNZAI_GUARD_PIPE: endpoint }
    delete env.NODE_OPTIONS
    delete env.NODE_PATH
    const program = `process.send({text:"\\0".repeat(11000)},error=>{if(!error)process.exit(9);process.send({type:"business-probe-ready"},failure=>{if(failure)process.exit(8)})});setInterval(()=>{},1000)`
    child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(path.join(repository, "dist/worker-preload.js")).href,
        "-e",
        program,
      ],
      { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    )
    let stderr = ""
    child.stdout.resume()
    child.stderr.on("data", bytes => {
      stderr = (stderr + bytes).slice(-8192)
    })
    const [code, signal] = await once(child, "exit")
    assert.equal(code, 0, stderr)
    assert.equal(signal, null)
    const summaries = frames.filter(frame => frame.event.operation === "worker-transport-summary")
    assert.equal(summaries.length, 1)
    assert.equal(summaries[0].event.details.transport.rejected, 1)
    assert.equal(summaries[0].event.details.transport.provenance, "guest-reported")
    assert.equal(seals.length, 1)
    assert.equal(seals[0].nestedCoverage, "incomplete")
    assert.equal(seals[0].sourceCounters.rejected.oversize, 0)
    assert.equal(seals[0].sourceCounters.unknown, 0)
    assert.equal(seals[0].lastSentSeq, frames.length)
  },
)
