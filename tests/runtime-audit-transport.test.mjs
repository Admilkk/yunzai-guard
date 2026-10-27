import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { RuntimeBroker, writeBrokerSocketFrame } from "../dist/runtime/broker.js"
import { createAuditDeadline, createAuditSourceCounters } from "../dist/audit/protocol.js"
import { parseSettings } from "../dist/config/index.js"

const nonce = () => randomBytes(24).toString("hex")
const observation = (channelNonce, auditSeq = 1) => ({
  auditProtocol: 1,
  generation: 3,
  channelNonce,
  auditSeq,
  type: "audit",
  event: { kind: "runtime", operation: "self-test", target: "owned-probe", action: "audit" },
})
const ack = frame => ({
  type: "audit-hop-ack",
  auditProtocol: 1,
  generation: frame.generation,
  channelNonce: frame.channelNonce,
  auditSeq: frame.auditSeq,
  result: "received",
})

test("Host broker replies bound bytes before touching a full or disconnected socket", () => {
  const writes = []
  const socket = {
    destroyed: false,
    writableLength: 0,
    write: value => {
      writes.push(value)
      return false
    },
  }
  const frame = { type: "audit-hop-ack", detail: "中文" }
  const bytes = Buffer.byteLength(JSON.stringify(frame) + "\n")
  socket.writableLength = 256 * 1024 - bytes
  assert.equal(writeBrokerSocketFrame(socket, frame), false)
  assert.equal(writes.length, 1)
  socket.writableLength++
  assert.throws(() => writeBrokerSocketFrame(socket, frame), /运行时审计应答队列超限/)
  socket.writableLength = 0
  assert.throws(
    () => writeBrokerSocketFrame(socket, { text: "中".repeat(22000) }),
    /审计字符串超长/,
  )
  assert.throws(
    () => writeBrokerSocketFrame(socket, { text: "\0".repeat(11000) }),
    /运行时审计应答超出帧限制/,
  )
  socket.destroyed = true
  assert.throws(() => writeBrokerSocketFrame(socket, frame), /运行时审计对端已断开/)
  assert.equal(writes.length, 1, "rejected replies never enter the underlying write queue")
})

test("broker cleanup attempts every actual peer and preserves failures after dropping each audit lane", async () => {
  const closed = [],
    drops = [],
    replies = []
  const broker = new RuntimeBroker(parseSettings({}), 3, "owned-fixture", () => {}, {
    onSource() {},
    onObservation({ frame }, reply) {
      reply(ack(frame))
    },
    onSeal() {},
    onDrop(value) {
      drops.push(value)
    },
  })
  await broker.listen(true)
  for (const key of ["broken", "healthy"]) {
    broker.receiveNative(
      key,
      { type: "runtime-hello", version: 1, token: broker.manifest.token, runtimeId: key },
      value => {
        replies.push({ key, value })
        if (value.type === "audit-hop-ack") throw new Error("outbound full")
      },
      () => {
        closed.push(key)
        if (key === "broken") throw new Error("owned native close failed")
      },
    )
    broker.receiveNative(
      key,
      observation(replies.find(reply => reply.key === key).value.channelNonce),
      () => {},
      () => {},
    )
  }
  await assert.rejects(broker.close(), error => {
    assert.ok(error instanceof AggregateError)
    assert.match(error.errors[0].message, /native close failed/)
    return true
  })
  assert.deepEqual(closed, ["broken", "healthy"])
  assert.equal(drops.length, 2)
  assert.ok(drops.every(value => value.counters.sendErrors >= 1 && value.counters.unknown >= 1))
  assert.equal(fs.existsSync(broker.directory), false)
})

test("an invalid native frame cannot skip actual-peer drop when its close callback rejects", async () => {
  const drops = []
  const broker = new RuntimeBroker(parseSettings({}), 3, "owned-fixture", () => {}, {
    onSource() {},
    onObservation() {},
    onSeal() {},
    onDrop(value) {
      drops.push(value)
    },
  })
  await broker.listen(true)
  broker.receiveNative(
    "actual-peer",
    { type: "runtime-hello", version: 1, token: broker.manifest.token, runtimeId: "label" },
    () => {},
    () => {
      throw new Error("owned close refused")
    },
  )
  assert.doesNotThrow(() =>
    broker.receiveNative(
      "actual-peer",
      { type: "invalid" },
      () => {},
      () => {
        throw new Error("owned close refused")
      },
    ),
  )
  assert.equal(drops.length, 1)
  assert.equal(drops[0].key, "actual-peer")
  assert.ok(drops[0].counters.sendErrors >= 1)
  await broker.close()
})
function nativePeer(broker, key, label = "same-guest-label") {
  const sent = []
  let closed = 0
  const send = message => sent.push(message)
  const close = () => {
    closed++
  }
  const receive = message => broker.receiveNative(key, message, send, close)
  receive({ type: "runtime-hello", version: 1, token: broker.manifest.token, runtimeId: label })
  return {
    sent,
    receive,
    get closed() {
      return closed
    },
    ready: sent[0],
  }
}

test("late outbound callback errors survive actual-peer retirement without becoming append receipts", async () => {
  const callbacks = [],
    drops = []
  const broker = new RuntimeBroker(parseSettings({}), 3, "late-callback", () => {}, {
    onSource() {},
    onObservation() {},
    onSeal() {},
    onDrop(value) {
      drops.push(value)
    },
  })
  await broker.listen(true)
  broker.receiveNative(
    "owned-channel",
    { type: "runtime-hello", version: 1, token: broker.manifest.token, runtimeId: "label" },
    (_value, callback) => {
      callbacks.push(callback)
      return false
    },
    () => {},
  )
  broker.dropNative("owned-channel")
  assert.equal(drops.length, 1)
  callbacks[0](new Error("late native callback error"))
  callbacks[0](null)
  assert.deepEqual(broker.transportStats(), {
    scope: "broker-outbound-only",
    evidence: "transport-callback-only",
    provenance: "host-owned",
    offered: 1,
    submitted: 1,
    completed: 0,
    rejected: 0,
    sendErrors: 1,
    channelErrors: 0,
    unknown: 1,
    afterDropErrors: 1,
    closed: 1,
  })
  await broker.close()
})

test("broker audit lanes use actual peers and refuse cross-channel, replayed and stale replies", async t => {
  const sources = [],
    observations = [],
    drops = [],
    registrations = []
  const broker = new RuntimeBroker(
    parseSettings({}),
    3,
    "audit-peers",
    (type, event) => registrations.push({ type, event }),
    {
      onSource: source => sources.push(source),
      onObservation: (input, reply) => observations.push({ ...input, reply }),
      onSeal() {},
      onDrop: value => drops.push(value),
    },
  )
  t.after(() => broker.close())
  const a = nativePeer(broker, "actual-A"),
    b = nativePeer(broker, "actual-B")
  assert.equal(sources.length, 2)
  assert.notEqual(sources[0].key, sources[1].key)
  assert.notEqual(a.ready.channelNonce, b.ready.channelNonce)
  assert.equal(sources[0].runtimeIdLabel, sources[1].runtimeIdLabel)
  assert.equal(registrations.length, 2)
  a.receive(observation(a.ready.channelNonce))
  const before = a.sent.length
  observations[0].reply({
    ...ack(observation(a.ready.channelNonce)),
    channelNonce: b.ready.channelNonce,
  })
  observations[0].reply({ ...ack(observation(a.ready.channelNonce)), generation: 2 })
  observations[0].reply({ ...ack(observation(a.ready.channelNonce)), auditSeq: 2 })
  assert.equal(a.sent.length, before)
  observations[0].reply(ack(observation(a.ready.channelNonce)))
  assert.equal(a.sent.at(-1).type, "audit-hop-ack")
  b.receive(observation(b.ready.channelNonce))
  assert.deepEqual(
    observations.map(row => row.key),
    ["actual-A", "actual-B"],
  )
  a.receive(observation(a.ready.channelNonce))
  assert.equal(a.closed, 1)
  assert.equal(drops[0].key, "actual-A")
  assert.ok(drops[0].counters.invalidFrames >= 4)
  assert.equal(broker.activeRuntimes, 1)
})

test("broker preparation remains audit-only and all close stages retain the first deadline", async t => {
  let peer,
    source,
    sealed,
    hostReplies = 0
  const broker = new RuntimeBroker(parseSettings({}), 3, "audit-close", () => {}, {
    onSource: value => {
      source = value
    },
    onObservation: ({ frame }, reply) => reply(ack(frame)),
    onSeal: ({ frame }, reply) => {
      sealed = frame
      reply({
        type: "audit-flush-result",
        auditProtocol: 1,
        generation: 3,
        channelNonce: frame.channelNonce,
        closeNonce: frame.closeNonce,
        cutoff: frame.lastSentSeq,
        scope: "this-source-only",
        outcome: "incomplete",
        receivedThrough: frame.lastSentSeq,
        settledThrough: frame.lastSentSeq,
        writtenThrough: 0,
        writtenCount: 0,
        rejectedCount: 0,
        unknownCount: 1,
        remainingCount: 0,
        evidence: "parent-hop-only",
      })
      hostReplies++
    },
    onDrop() {},
  })
  t.after(() => broker.close())
  peer = nativePeer(broker, "actual-close")
  const close = { nonce: nonce(), deadline: createAuditDeadline(80) }
  broker.prepareAudit(close)
  assert.equal(
    peer.sent.some(frame => frame.type === "runtime-stop"),
    false,
  )
  peer.receive(observation(source.channelNonce))
  const counts = createAuditSourceCounters()
  Object.assign(counts, { offered: 1, accepted: 1, sendCompleted: 1, hopReceived: 1 })
  peer.receive({
    type: "audit-seal",
    auditProtocol: 1,
    generation: 3,
    channelNonce: source.channelNonce,
    closeNonce: close.nonce,
    lastSentSeq: 1,
    sourceCounters: counts,
    nestedCoverage: "settled",
  })
  assert.ok(sealed)
  assert.equal(hostReplies, 1)
  assert.equal(
    peer.sent.some(frame => frame.type === "audit-flush-result"),
    false,
    "parent-hop cannot be sent as Host append evidence",
  )
  broker.prepareAudit({ nonce: close.nonce, deadline: createAuditDeadline(5000) })
  const started = performance.now()
  await Promise.all([
    broker.close(close),
    broker.close({ nonce: close.nonce, deadline: createAuditDeadline(5000) }),
  ])
  assert.ok(
    performance.now() - started < 1000,
    "a second close cannot renew the original audit budget",
  )
  assert.equal(peer.sent.filter(frame => frame.type === "runtime-stop").length, 1)
  assert.equal(peer.closed, 1)
})

function directory(t) {
  const base = fs.realpathSync.native(os.tmpdir())
  const root = fs.mkdtempSync(path.join(base, "guard-audit-transport-"))
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync.native(root)), base)
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}
function ownedChild(t, args, options) {
  const child = spawn(process.execPath, args, {
    ...options,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  const exited = once(child, "exit")
  let stderr = "",
    forced = false
  child.stderr.on("data", bytes => {
    stderr += bytes
  })
  child.stdout.resume()
  const timer = setTimeout(() => {
    forced = true
    child.kill("SIGKILL")
  }, 10000)
  t.after(async () => {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL")
      await exited
    }
  })
  return {
    child,
    exited,
    get stderr() {
      return stderr
    },
    get forced() {
      return forced
    },
  }
}
function cleanEnvironment(extra = {}) {
  const env = { ...process.env, ...extra }
  for (const key of Object.keys(env))
    if (
      ["NODE_OPTIONS", "NODE_PATH", "PM2_NODE_OPTIONS"].includes(key) ||
      (key.startsWith("YUNZAI_GUARD_") && !Object.hasOwn(extra, key))
    )
      delete env[key]
  return env
}

test(
  "primary IPC rejects invalid ACKs and waits for its own Host result within the original close budget",
  { timeout: 10000 },
  async t => {
    const root = directory(t),
      channelNonce = nonce(),
      closeNonce = nonce(),
      written = []
    const appendFile = path.join(root, "host-append.log")
    const probe = ownedChild(
      t,
      [
        "--import",
        new URL("../dist/worker-preload.js", import.meta.url).href,
        "--input-type=module",
        "--eval",
        `const context=globalThis[Symbol.for('yunzai.guard.context.v1')];context.send('audit',{event:{kind:'runtime',operation:'self-test',target:'primary',action:'audit'}});process.send({type:'audit-test-ready'});setInterval(()=>{},1000)`,
      ],
      { cwd: root, env: cleanEnvironment() },
    )
    let seal,
      premature = false,
      badAckSent = false,
      resultTimer
    probe.child.on("message", message => {
      if (message.type === "preload-hello")
        probe.child.send({
          type: "worker-handshake",
          nonce: message.nonce,
          projectId: message.projectId,
          generation: 3,
          settings: { protect: { enabled: false }, shutdownTimeout: 1000 },
          sandboxSources: [],
          auditChannelNonce: channelNonce,
          controlKey: "a".repeat(64),
        })
      if (message.auditProtocol === 1 && ["audit", "violation"].includes(message.type)) {
        fs.appendFileSync(appendFile, JSON.stringify(message) + "\n")
        written.push(message)
        if (!badAckSent) {
          badAckSent = true
          probe.child.send({ ...ack(message), generation: 2 })
          probe.child.send({ ...ack(message), channelNonce: nonce() })
          probe.child.send({ ...ack(message), auditSeq: message.auditSeq + 100 })
        }
        probe.child.send(ack(message))
      }
      if (message.type === "audit-test-ready") {
        probe.child.send({
          type: "audit-prepare-flush",
          auditProtocol: 1,
          generation: 3,
          channelNonce: nonce(),
          closeNonce,
          remainingBudgetMs: 1000,
          scope: "this-source-only",
        })
        probe.child.send({
          type: "audit-prepare-flush",
          auditProtocol: 1,
          generation: 3,
          channelNonce,
          closeNonce,
          remainingBudgetMs: 1000,
          scope: "this-source-only",
        })
        probe.child.send({ type: "shutdown", generation: 3 })
      }
      if (message.type === "audit-seal") {
        seal = message
        const result = {
          type: "audit-flush-result",
          auditProtocol: 1,
          generation: 3,
          channelNonce,
          closeNonce,
          cutoff: message.lastSentSeq,
          scope: "this-source-only",
          outcome: "incomplete",
          receivedThrough: message.lastSentSeq,
          settledThrough: message.lastSentSeq,
          writtenThrough: message.lastSentSeq,
          writtenCount: message.lastSentSeq,
          rejectedCount: 0,
          unknownCount: message.sourceCounters.unknown,
          remainingCount: 0,
          evidence: "host-append-completed",
        }
        probe.child.send({ ...result, closeNonce: nonce() })
        probe.child.send({ ...result, evidence: "parent-hop-only" })
        resultTimer = setTimeout(() => {
          premature = probe.child.exitCode !== null
          probe.child.send(result)
        }, 40)
      }
    })
    t.after(() => clearTimeout(resultTimer))
    const [code, signal] = await probe.exited
    assert.equal(code, 0, probe.stderr)
    assert.equal(signal, null)
    assert.equal(probe.forced, false)
    assert.ok(seal)
    assert.equal(seal.closeNonce, closeNonce)
    assert.equal(seal.lastSentSeq, written.length)
    assert.ok(
      seal.sourceCounters.invalidReplies >= 4,
      "invalid generation/channel/ahead ACK and prepare are visible",
    )
    assert.equal(seal.nestedCoverage, "settled")
    assert.equal(premature, false, "wrong nonce or a parent-hop result cannot finish the Host wait")
    assert.equal(fs.readFileSync(appendFile, "utf8").trim().split("\n").length, written.length)
  },
)

test(
  "external socket shutdown seals once and an absent Host result cannot renew the shutdown budget",
  { timeout: 10000 },
  async t => {
    const root = directory(t),
      sources = [],
      seals = []
    let registered
    const ready = new Promise(resolve => {
      registered = resolve
    })
    const broker = new RuntimeBroker(
      parseSettings({ protect: { enabled: false } }),
      3,
      "external-audit",
      () => {},
      {
        onSource: source => {
          sources.push(source)
          registered()
        },
        onObservation: ({ frame }, reply) => reply(ack(frame)),
        onSeal: ({ frame }) => seals.push(frame),
        onDrop() {},
      },
    )
    t.after(() => broker.close())
    await broker.listen()
    const probe = ownedChild(
      t,
      [
        "--require",
        fileURLToPath(new URL("../dist/runtime-bootstrap.cjs", import.meta.url)),
        "--import",
        new URL("../dist/child-preload.js", import.meta.url).href,
        "--input-type=module",
        "--eval",
        "process.send({type:'audit-test-ready'});setInterval(()=>{},1000)",
      ],
      { cwd: root, env: cleanEnvironment({ YUNZAI_GUARD_RUNTIME_MANIFEST: broker.manifestPath }) },
    )
    const applicationReady = once(probe.child, "message")
    await ready
    // 注册仅代表通道已建立，退出预算从预加载完成后开始。
    assert.equal((await applicationReady)[0].type, "audit-test-ready")
    const close = { nonce: nonce(), deadline: createAuditDeadline(120) }
    broker.prepareAudit(close)
    const started = performance.now()
    await broker.close(close)
    const [code, signal] = await probe.exited
    assert.equal(code, 0, probe.stderr)
    assert.equal(signal, null)
    assert.equal(probe.forced, false)
    assert.ok(performance.now() - started < 1500)
    assert.equal(sources.length, 1)
    assert.equal(seals.length, 1)
    assert.equal(seals[0].closeNonce, close.nonce)
    assert.equal(seals[0].channelNonce, sources[0].channelNonce)
  },
)
