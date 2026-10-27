import assert from "node:assert/strict"
import { PassThrough, Duplex } from "node:stream"
import { EventEmitter } from "node:events"
import test from "node:test"
import {
  BoundedJsonLines,
  attachNativeTransport,
  maxTransportFrameBytes,
  NativeIngressBudget,
} from "../dist/native-sandbox/transport.js"

function fixture() {
  const messages = [],
    errors = [],
    stream = new PassThrough()
  const decoder = new BoundedJsonLines(
    value => messages.push(value),
    error => errors.push(error),
  )
  stream.on("data", chunk => decoder.write(chunk))
  stream.on("end", () => decoder.end())
  return { messages, errors, stream, decoder }
}

test("bounded native JSON frames support multiple frames and fragmented UTF-8", () => {
  const f = fixture()
  const first = Buffer.from('{"message":"中文"}\n')
  for (const byte of first) f.stream.write(Buffer.from([byte]))
  f.stream.write('{"next":1}\n{"next":2}\n')
  assert.deepEqual(f.messages, [{ message: "中文" }, { next: 1 }, { next: 2 }])
  assert.deepEqual(f.errors, [])
  f.stream.destroy()
})

test("oversized input is rejected before JSON parsing, with or without a newline", () => {
  for (const newline of [false, true]) {
    const f = fixture()
    // 故意提供无效 JSON，以验证先检查大小再解析语法。
    f.stream.write(Buffer.alloc(maxTransportFrameBytes, 120))
    assert.equal(f.errors.length, 0)
    f.stream.write(newline ? "x\n" : "x")
    assert.equal(f.errors.length, 1)
    assert.match(f.errors[0].message, /IPC 帧超过 64 KiB（解析前）/)
    f.stream.write('{"mustNotRun":true}\n')
    assert.deepEqual(f.messages, [])
    f.stream.destroy()
  }
})

test("a large chunk containing bounded frames below the session burst budget is accepted", () => {
  const f = fixture()
  const chunk = `{"ok":true,"padding":"${"x".repeat(64)}"}\n`.repeat(1000)
  assert.ok(Buffer.byteLength(chunk) > maxTransportFrameBytes)
  f.stream.write(chunk)
  assert.equal(f.messages.length, 1000)
  assert.deepEqual(f.errors, [])
  f.stream.destroy()
})

test("raw frame floods stop before parsing or delivering excess frames and remain sealed", () => {
  const messages = [],
    errors = [],
    budget = new NativeIngressBudget(() => 0)
  const decoder = new BoundedJsonLines(
    value => messages.push(value),
    error => errors.push(error),
    maxTransportFrameBytes,
    budget,
  )
  decoder.write(Buffer.from('{"ok":true}\n'.repeat(10000)))
  assert.equal(messages.length, 4096)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, "NATIVE_INGRESS_LIMIT")
  assert.equal(budget.sealed, true)
  decoder.write(Buffer.from('{"mustNotRun":true}\n'))
  assert.equal(messages.length, 4096)
  assert.equal(errors.length, 1)
})

test("oversized aggregate input is rejected before JSON parsing even if every frame is small", () => {
  const messages = [],
    errors = [],
    budget = new NativeIngressBudget(() => 0)
  const decoder = new BoundedJsonLines(
    value => messages.push(value),
    error => errors.push(error),
    maxTransportFrameBytes,
    budget,
  )
  decoder.write(Buffer.alloc(8 * 1024 * 1024 + 1, 10))
  assert.equal(messages.length, 0)
  assert.equal(errors[0].code, "NATIVE_INGRESS_LIMIT")
})

test("tiny fragment floods cannot force unbounded bookkeeping or quadratic buffer copies", () => {
  const f = fixture()
  f.stream.write('{"data":"')
  for (let index = 0; index < 2000; index++) f.stream.write("x")
  assert.equal(f.messages.length, 0)
  assert.equal(f.errors.length, 1)
  assert.match(f.errors[0].message, /IPC 帧分片超限/)
  f.stream.write('"}\n')
  assert.equal(f.messages.length, 0)
  f.stream.destroy()
})

test("malformed UTF-8, truncated frames and Node handle-transfer commands fail closed", () => {
  for (const bytes of [
    Buffer.from('{"cmd":"NODE_HANDLE","type":"net.Socket"}\n'),
    Buffer.from([0x22, 0xff, 0x22, 0x0a]),
  ]) {
    const f = fixture()
    f.stream.write(bytes)
    assert.equal(f.errors.length, 1)
    assert.deepEqual(f.messages, [])
    f.stream.destroy()
  }
  const f = fixture()
  f.stream.write('{"unfinished":')
  f.decoder.end()
  assert.match(f.errors[0].message, /IPC 以不完整的帧结束/)
  f.stream.destroy()
})

test("parent transport sends bounded newline frames and rejects handle-transfer arguments", async () => {
  const child = new EventEmitter(),
    outbound = [],
    failures = []
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      outbound.push(chunk.toString())
      callback()
    },
  })
  attachNativeTransport(child, stream, error => failures.push(error))
  assert.equal(child.connected, true)
  const received = []
  child.on("message", value => received.push(value))
  stream.push('{"type":"preload-hello"}\n')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(received, [{ type: "preload-hello" }])
  child.send({ type: "native-load" })
  assert.deepEqual(outbound, ['{"type":"native-load"}\n'])
  child.send({ type: "invalid" }, { fakeHandle: true })
  assert.equal(failures.length, 1)
  assert.equal(child.connected, false)
  assert.equal(stream.destroyed, true)
})
