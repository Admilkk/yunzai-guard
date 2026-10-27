import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { PassThrough, Writable } from "node:stream"
import test from "node:test"
import { installHostLog, pipeHostOutput } from "../dist/host/log.js"

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "guard-host-log-"))
  const out = [],
    err = []
  const stdout = new Writable({
    write(chunk, encoding, callback) {
      out.push(Buffer.from(chunk))
      callback()
    },
  })
  const stderr = new Writable({
    write(chunk, encoding, callback) {
      err.push(Buffer.from(chunk))
      callback()
    },
  })
  const restore = installHostLog(directory, { stdout, stderr, ...options })
  t.after(() => {
    restore()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { directory, file: path.join(directory, "host.log"), stdout, stderr, out, err }
}

test("host log preserves write encoding, callbacks, backpressure and stream lifetime", async t => {
  const writes = []
  let release
  const stdout = new Writable({
    highWaterMark: 1,
    write(chunk, encoding, callback) {
      writes.push(Buffer.from(chunk))
      release = callback
    },
  })
  const original = stdout.write
  const value = fixture(t, { stdout })
  let called = 0
  assert.equal(
    stdout.write("é", "latin1", () => called++),
    false,
  )
  assert.equal(called, 0)
  assert.deepEqual(fs.readFileSync(value.file), Buffer.from([0xe9]))
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(called, 1)
  assert.deepEqual(Buffer.concat(writes), Buffer.from([0xe9]))
  assert.equal(stdout.writableEnded, false)
  assert.notEqual(stdout.write, original)
})

test("stdout and stderr rotate during runtime and retain only two bounded files", t => {
  const value = fixture(t, { maxBytes: 32 })
  const chunks = Array.from({ length: 12 }, (_, index) => Buffer.alloc(16, 65 + index))
  chunks.forEach((chunk, index) => (index % 2 ? value.stderr : value.stdout).write(chunk))
  const files = fs.readdirSync(value.directory).sort()
  assert.deepEqual(files, ["host.log", "host.log.1"])
  const retained = ["host.log.1", "host.log"].map(name =>
    fs.readFileSync(path.join(value.directory, name)),
  )
  assert.ok(retained.every(chunk => chunk.length <= 32))
  assert.deepEqual(Buffer.concat(retained), Buffer.concat(chunks).subarray(-64))
  assert.deepEqual(
    Buffer.concat(value.out),
    Buffer.concat(chunks.filter((_, index) => index % 2 === 0)),
  )
  assert.deepEqual(Buffer.concat(value.err), Buffer.concat(chunks.filter((_, index) => index % 2)))
})

test("legacy oversized logs and single oversized writes stay bounded", t => {
  const value = fixture(t, { maxBytes: 32 })
  fs.writeFileSync(value.file, Buffer.alloc(256, "a"))
  value.stdout.write("b")
  assert.equal(fs.statSync(`${value.file}.1`).size, 32)
  const bytes = Buffer.from(Array.from({ length: 200 }, (_, index) => index))
  value.stderr.write(bytes)
  assert.ok(fs.statSync(`${value.file}.1`).size <= 32)
  assert.ok(fs.statSync(value.file).size <= 32)
  const retained = Buffer.concat([fs.readFileSync(`${value.file}.1`), fs.readFileSync(value.file)])
  assert.deepEqual(retained, bytes.subarray(-retained.length))
})

test("unsafe log targets are never modified and failure reports only once", t => {
  const value = fixture(t)
  const target = path.join(value.directory, "protected.txt")
  fs.writeFileSync(target, "unchanged")
  fs.linkSync(target, value.file)
  value.stdout.write("one")
  value.stdout.write("two")
  value.stderr.write("three")
  assert.equal(fs.readFileSync(target, "utf8"), "unchanged")
  assert.equal(Buffer.concat(value.out).toString(), "onetwo")
  const errors = Buffer.concat(value.err).toString()
  assert.equal(errors.match(/host.log unavailable/g)?.length, 1)
  assert.ok(errors.endsWith("three"))
})

test("worker pipes preserve output, exit status and drain without closing host streams", async t => {
  const value = fixture(t, { maxBytes: 512 * 1024 })
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.stdout.write('o'.repeat(96000));process.stderr.write('e'.repeat(96000));process.exitCode=17",
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  )
  const exited = once(child, "exit")
  const drain = pipeHostOutput(child, value.stdout, value.stderr)
  assert.equal((await exited)[0], 17)
  await drain(5000)
  assert.equal(Buffer.concat(value.out).toString(), "o".repeat(96000))
  assert.equal(Buffer.concat(value.err).toString(), "e".repeat(96000))
  const log = fs.readFileSync(value.file, "utf8")
  assert.equal(log.replaceAll("o", "").length, 96000)
  assert.equal(log.replaceAll("e", "").length, 96000)
  assert.equal(value.stdout.writableEnded, false)
  assert.equal(value.stderr.writableEnded, false)
})

test("output drain is bounded and reports source errors", async t => {
  const value = fixture(t)
  const source = new PassThrough()
  const drain = pipeHostOutput({ stdout: source, stderr: null }, value.stdout, value.stderr)
  await assert.rejects(drain(10), /工作进程输出排空超时/)
  source.destroy(new Error("output failure"))
  await assert.rejects(drain(100), /output failure/)
})
