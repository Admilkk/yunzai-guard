import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"
import {
  createWindowsSandboxTransportCounters,
  createWindowsCanonicalObserver,
  disposeWindowsSandboxProcess,
  forwardWindowsSandboxOutput,
  writeWindowsSandboxControl,
  windowsSandboxSourceNames,
} from "../dist/sandbox/windows.js"

function canonicalSnapshot(overrides = {}) {
  return {
    protocol: 1,
    enabled: true,
    disabled: false,
    offered: 1,
    acceptedRoot: 1,
    completed: 0,
    rejected: 0,
    unsupported: 0,
    timedOut: 0,
    unknown: 0,
    ...overrides,
  }
}

test("Windows canonical snapshots retain operation unknown after the original helper exits", () => {
  const observer = createWindowsCanonicalObserver(true)
  assert.equal(observer.record("ready", canonicalSnapshot()), true)
  // offered 统计连接数，completed 统计查询数，两者独立。
  assert.equal(
    observer.record("exit", canonicalSnapshot({ completed: 5, disabled: true, timedOut: 1 })),
    true,
  )
  assert.equal(
    observer.record(
      "cleanup",
      canonicalSnapshot({ completed: 5, disabled: true, timedOut: 1, unknown: 2 }),
      false,
    ),
    true,
  )
  observer.nativeExit(0, null)
  observer.outputClosed()
  const state = observer.stats()
  assert.equal(state.scope, "canonical-metadata-only")
  assert.equal(state.provenance, "native-broker-reported")
  assert.equal(state.cleanupUnknown, true)
  assert.equal(state.cleanupConfirmed, false)
  assert.equal(state.nativeHelperResourcesReleased, true)
  assert.equal(state.nativeOutputClosed, true)
  assert.equal(state.finalSnapshotMissing, false)
  assert.equal(state.snapshot.unknown, 2)
  assert.equal(state.snapshot.timedOut, 1)
  state.snapshot.unknown = 0
  assert.equal(observer.stats().snapshot.unknown, 2)
})

test("Windows canonical snapshots reject extra fields, wrong capability, counter regressions and duplicate stages", () => {
  const observer = createWindowsCanonicalObserver(true)
  assert.equal(observer.record("ready", canonicalSnapshot({ other: true })), false)
  assert.equal(observer.record("ready", canonicalSnapshot({ enabled: false })), false)
  assert.equal(observer.record("ready", canonicalSnapshot({ unknown: -1 })), false)
  assert.equal(observer.record("ready", canonicalSnapshot({ acceptedRoot: 2 })), false)
  assert.equal(observer.record("ready", canonicalSnapshot({ completed: 3 })), true)
  assert.equal(observer.record("exit", canonicalSnapshot({ completed: 2 })), false)
  assert.equal(observer.record("exit", canonicalSnapshot({ completed: 3, disabled: true })), true)
  assert.equal(observer.record("cleanup", canonicalSnapshot({ completed: 3 }), true), false)
  assert.equal(
    observer.record("cleanup", canonicalSnapshot({ completed: 3, disabled: true }), true),
    true,
  )
  assert.equal(
    observer.record("cleanup", canonicalSnapshot({ completed: 3, disabled: true }), true),
    false,
  )
  const state = observer.stats()
  assert.equal(state.reports.invalid, 7)
  assert.equal(state.cleanupUnknown, true)
  assert.equal(state.cleanupConfirmed, true)
})

test("Windows canonical missing final report remains unknown and disabled mode has the same zero schema", () => {
  const observer = createWindowsCanonicalObserver(false)
  const disabled = canonicalSnapshot({
    enabled: false,
    disabled: true,
    offered: 0,
    acceptedRoot: 0,
  })
  assert.equal(observer.record("ready", disabled), true)
  assert.equal(observer.record("exit", { ...disabled, completed: 1 }), false)
  observer.nativeExit(0, null)
  observer.outputClosed()
  assert.equal(observer.stats().finalSnapshotMissing, true)
  assert.equal(observer.stats().cleanupUnknown, true)
  assert.equal(observer.stats().nativeHelperResourcesReleased, true)
  const clean = createWindowsCanonicalObserver(false)
  assert.equal(clean.record("cleanup", disabled, true), true)
  clean.outputClosed()
  assert.equal(clean.stats().cleanupUnknown, false)
  assert.equal(clean.stats().finalSnapshotMissing, false)
})

test("Windows canonical independent stdout/stderr arrival order never overwrites the later logical snapshot", () => {
  const observer = createWindowsCanonicalObserver(true)
  assert.equal(
    observer.record(
      "cleanup",
      canonicalSnapshot({ completed: 3, disabled: true, unknown: 1 }),
      false,
    ),
    true,
  )
  assert.equal(observer.record("exit", canonicalSnapshot({ completed: 3, disabled: true })), true)
  assert.equal(observer.record("ready", canonicalSnapshot()), true)
  const state = observer.stats()
  assert.deepEqual(state.reports, { ready: true, exit: true, cleanup: true, invalid: 0 })
  assert.equal(state.latestStage, "cleanup")
  assert.equal(state.snapshot.unknown, 1)
  assert.equal(state.cleanupUnknown, true)
})

function writable() {
  const writes = []
  const callbacks = []
  return {
    writable: true,
    destroyed: false,
    writableLength: 0,
    writes,
    callbacks,
    write(value, callback) {
      writes.push(value)
      callbacks.push(callback)
      return false
    },
  }
}

test("Windows native stdin bounds real queued bytes, reports callback rejection and throws without a callback", () => {
  const stream = writable()
  const counters = createWindowsSandboxTransportCounters().control
  const message = { detail: "中文" }
  const bytes = Buffer.byteLength(JSON.stringify(message) + "\n")
  stream.writableLength = 256 * 1024 - bytes
  assert.equal(writeWindowsSandboxControl(stream, true, message, counters), false)
  stream.callbacks[0](null)
  stream.writableLength++
  let error
  assert.equal(
    writeWindowsSandboxControl(stream, true, message, counters, value => {
      error = value
    }),
    false,
  )
  assert.match(error.message, /队列超过|队列超限/)
  assert.throws(
    () => writeWindowsSandboxControl(stream, true, message, counters),
    /队列超过|队列超限/,
  )
  stream.writableLength = 0
  assert.throws(
    () => writeWindowsSandboxControl(stream, true, { text: "中".repeat(22000) }, counters),
    /帧过大/,
  )
  assert.throws(() => writeWindowsSandboxControl(stream, false, message, counters), /disconnected/)
  assert.deepEqual(counters, {
    offered: 5,
    accepted: 1,
    completed: 1,
    rejected: 4,
    unknown: 0,
    closed: 1,
  })
  assert.equal(stream.writes.length, 1)
})

test("Windows native send failures remain unknown rather than successful audit writes", () => {
  const stream = writable()
  const counters = createWindowsSandboxTransportCounters().control
  const results = []
  writeWindowsSandboxControl(stream, true, { type: "stop" }, counters, error => results.push(error))
  stream.callbacks[0](new Error("owned pipe failed"))
  stream.callbacks[0](null)
  assert.equal(results.length, 1)
  assert.match(results[0].message, /owned pipe failed/)
  stream.write = () => {
    throw new Error("synchronous pipe failure")
  }
  assert.throws(() => writeWindowsSandboxControl(stream, true, {}, counters), /synchronous/)
  assert.equal(counters.unknown, 2)
  assert.equal(counters.completed, 0)
})

test("Windows output forwarding drops a full output stream while later control input can keep draining", () => {
  const stream = writable()
  const counters = createWindowsSandboxTransportCounters().output
  const bytes = Buffer.alloc(4096)
  stream.writableLength = 256 * 1024 - bytes.length
  assert.equal(forwardWindowsSandboxOutput(stream, bytes, counters), false)
  stream.writableLength++
  assert.equal(forwardWindowsSandboxOutput(stream, bytes, counters), false)
  stream.callbacks[0](new Error("user output disconnected"))
  stream.destroyed = true
  assert.equal(forwardWindowsSandboxOutput(stream, bytes, counters), false)
  assert.deepEqual(counters, {
    offeredBytes: 12288,
    forwardedBytes: 4096,
    droppedBytes: 8192,
    unknownBytes: 4096,
  })
  assert.equal(stream.writes.length, 1)
})

test("Windows disposal waits for original exit and cleanup even when stop cannot be queued", async () => {
  const order = []
  let exited = false
  let resolveExit, resolveCleanup
  const exit = new Promise(resolve => {
    resolveExit = resolve
  })
  const cleanup = new Promise(resolve => {
    resolveCleanup = resolve
  })
  const disposal = disposeWindowsSandboxProcess({
    stop: () => {
      order.push("stop-rejected")
      throw new Error("stdin full")
    },
    hasExited: () => exited,
    kill: () => {
      order.push("original-handle-kill")
      setTimeout(() => {
        exited = true
        order.push("original-exit")
        resolveExit()
      }, 5)
      setTimeout(() => {
        order.push("cleanup-confirmed")
        resolveCleanup()
      }, 15)
    },
    exited: exit,
    cleanup,
    timeout: 200,
  })
  await assert.rejects(disposal, error => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.errors[0].message, "stdin full")
    assert.deepEqual(order, [
      "stop-rejected",
      "original-handle-kill",
      "original-exit",
      "cleanup-confirmed",
    ])
    return true
  })
})

test("Windows disposal preserves a cleanup rejection after original exit and reports unconfirmed exhaustion", async () => {
  await assert.rejects(
    disposeWindowsSandboxProcess({
      stop() {},
      hasExited: () => true,
      kill: () => assert.fail("already exited"),
      exited: Promise.resolve(),
      cleanup: Promise.reject(new Error("journal retained")),
      timeout: 100,
    }),
    error => error.errors.some(item => /日志保留在/.test(item.message)),
  )
  let kills = 0
  await assert.rejects(
    disposeWindowsSandboxProcess({
      stop() {},
      hasExited: () => false,
      kill: () => {
        kills++
      },
      exited: new Promise(() => {}),
      cleanup: new Promise(() => {}),
      timeout: 30,
    }),
    error => error.errors.some(item => /退出与清理未确认/.test(item.message)),
  )
  assert.equal(kills, 1)
})

test(
  "Windows native per-client queue isolates a non-reading pipe and expires a fixed original frame deadline",
  { skip: process.platform !== "win32", timeout: 20000 },
  t => {
    const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
    const run = fs.mkdtempSync(path.join(repository, "tests/runs/windows-pipe-backpressure-"))
    const compiler = path.join(
      process.env.SystemRoot || "C:/Windows",
      "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
    )
    const executable = path.join(run, "pipe-probe.exe")
    const compilation = spawnSync(
      compiler,
      [
        "/nologo",
        "/utf8output",
        "/target:exe",
        "/main:WindowsPipeBackpressureProbe",
        "/reference:System.Web.Extensions.dll",
        `/out:${executable}`,
        ...windowsSandboxSourceNames.map(file => path.join(repository, "native/windows", file)),
        path.join(repository, "tests/fixtures/windows-pipe-backpressure.cs"),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15000 },
    )
    fs.writeFileSync(path.join(run, "compile.stdout.log"), compilation.stdout || "")
    fs.writeFileSync(path.join(run, "compile.stderr.log"), compilation.stderr || "")
    assert.equal(compilation.status, 0, `${compilation.stdout}${compilation.stderr}`)
    const execution = spawnSync(executable, [], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    })
    fs.writeFileSync(path.join(run, "probe.stdout.log"), execution.stdout || "")
    fs.writeFileSync(path.join(run, "probe.stderr.log"), execution.stderr || "")
    fs.writeFileSync(
      path.join(run, "native.json"),
      JSON.stringify(
        {
          compileExit: compilation.status,
          nativeExit: execution.status,
          signal: execution.signal,
          error: execution.error?.message ?? null,
        },
        null,
        2,
      ),
    )
    assert.equal(execution.status, 0, `${execution.stdout}${execution.stderr}`)
    const result = JSON.parse(execution.stdout.trim())
    assert.equal(result.scope, "owned-loopback-pipe-transport-only")
    assert.equal(result.canonicalDisabledScrubbed, true)
    assert.equal(result.canonicalDisabledStopConfirmed, true)
    assert.equal(result.exactCapacity, true)
    assert.equal(result.unicodeRejected, true)
    assert.equal(result.peerIndependent, true)
    assert.equal(result.expiredClosed, true)
    assert.ok(result.unknown >= 1)
    assert.equal(result.retainedAfterClose, 0)
    assert.ok(result.healthyRoundTripMs < 1000)
    assert.ok(result.expiredMs >= 1700 && result.expiredMs < 5000)
    t.diagnostic(
      `Native pipe-only fixture retained at ${run}; no Job/SID or PM2 qualification is claimed`,
    )
  },
)
