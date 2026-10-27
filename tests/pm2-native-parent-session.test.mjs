import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import cp from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import test from "node:test"
import { ParentInspector } from "../dist/pm2/inspector.js"

function boundary(t, options = {}) {
  const trace = [],
    pid = 45001
  const endpoint = {
    url: "ws://127.0.0.1:64500/owned-node",
    connectUrl: "ws://127.0.0.1:64500/owned-node",
    wildcard: false,
  }
  const proof = { pid, created: "123", commandLine: "preflight clue only" }
  let alive = true,
    currentEndpoint = options.existing ? endpoint : undefined,
    activationCalls = 0,
    socket,
    budget = 1000
  class Socket extends EventTarget {
    static CLOSED = 3
    readyState = 0
    constructor() {
      super()
      socket = this
      trace.push("websocket-created")
      queueMicrotask(() => {
        this.readyState = 1
        trace.push("websocket-open")
        this.dispatchEvent(new Event("open"))
      })
    }
    send(text) {
      assert.equal(alive, true)
      const frame = JSON.parse(text)
      trace.push("runtime-send:" + frame.id)
      const value = {
        pid,
        name: "pm2",
        version: "7.1.0",
        godCached: true,
        inspectorUrl: endpoint.url,
        main: path.join("fixture", "lib", "Daemon.js"),
        pm2Root: "fixture",
      }
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({ id: frame.id, result: { result: { value } } }),
          }),
        ),
      )
    }
    close() {
      if (this.readyState === 3) return
      trace.push("websocket-close-request")
      this.readyState = 2
      queueMicrotask(() => {
        this.readyState = 3
        trace.push("websocket-closed")
        this.dispatchEvent(new Event("close"))
      })
    }
  }
  const previous = {
    WebSocket: globalThis.WebSocket,
    fetch: globalThis.fetch,
    debug: process._debugProcess,
    readDir: fs.readdirSync,
    readFile: fs.readFileSync,
    execute: cp.execFileSync,
  }
  globalThis.WebSocket = Socket
  globalThis.fetch = async () => new Response("[]")
  process._debugProcess = () => {
    throw Error("Numeric PID activation must never be used")
  }
  // 夹具仅提供空的只读监听器清单，不提供目标操作。
  fs.readdirSync = (file, ...args) =>
    String(file) === `/proc/${pid}/fd` ? [] : previous.readDir(file, ...args)
  fs.readFileSync = (file, ...args) =>
    /^\/proc\/45001\/net\/tcp6?$/.test(String(file)) ? "header\n" : previous.readFile(file, ...args)
  cp.execFileSync = (file, ...args) =>
    file === "netstat.exe" ? "" : previous.execute(file, ...args)
  syncBuiltinESMExports()
  t.after(() => {
    globalThis.WebSocket = previous.WebSocket
    globalThis.fetch = previous.fetch
    process._debugProcess = previous.debug
    fs.readdirSync = previous.readDir
    fs.readFileSync = previous.readFile
    cp.execFileSync = previous.execute
    syncBuiltinESMExports()
  })
  const session = {
    parent: {
      pid: options.mismatchedParent ? pid + 1 : pid,
      birth: { kind: "windows-filetime-100ns", value: "1234567" },
    },
    activationAvailable: !options.unsupported,
    unavailableReason: options.unsupported ? "UNSUPPORTED_NODE_PROFILE" : undefined,
    async activateOnce() {
      activationCalls++
      trace.push("held-parent-activation")
      currentEndpoint = endpoint
      return {
        result: options.activationUnknown ? "started-unconfirmed" : "native-action-completed",
      }
    },
    async confirmAfterWebSocket(serial) {
      trace.push("native-confirm:" + serial)
      if (!alive || options.confirmRefused) throw Error("Held original parent is unavailable")
      return { parent: this.parent, originalLive: true }
    },
    async close() {
      trace.push("native-session-close")
    },
  }
  const nativeIdentity = {
    async openInspectorParent(input) {
      trace.push("native-open:" + input.remainingBudgetMs)
      assert.equal(
        Object.hasOwn(input, "expectedParent"),
        false,
        "CIM creation ticks must not be passed as native identity",
      )
      return session
    },
  }
  const connectOptions = {
    nativeIdentity,
    deadline: { remainingMs: () => budget },
    async discover() {
      trace.push("readonly-discover")
      if (options.expireAfterDiscovery) budget = 0
      return currentEndpoint
    },
  }
  return {
    trace,
    proof,
    connectOptions,
    session,
    get socket() {
      return socket
    },
    get activationCalls() {
      return activationCalls
    },
    die() {
      alive = false
    },
    endpoint,
    closeOwned: async () => {
      assert.equal(socket.readyState, Socket.CLOSED)
      trace.push("owned-ipc-close")
      currentEndpoint = undefined
    },
  }
}

test("an existing Inspector binds the original held parent even when fresh activation is unsupported", async t => {
  const probe = boundary(t, { existing: true, unsupported: true })
  const session = await ParentInspector.connect(probe.proof, probe.connectOptions)
  assert.equal(session.opened, false)
  assert.equal(probe.activationCalls, 0)
  await session.identity()
  await session.verifyParent()
  await session.close(() => {
    throw Error("An existing endpoint must not be closed")
  })
  const open = probe.trace.indexOf("websocket-open"),
    confirm = probe.trace.indexOf("native-confirm:1"),
    runtime = probe.trace.findIndex(value => value.startsWith("runtime-send:"))
  assert.ok(open < confirm && confirm < runtime)
  assert.deepEqual(
    probe.trace.filter(value => value.startsWith("native-confirm:")),
    ["native-confirm:1", "native-confirm:2", "native-confirm:3"],
  )
  assert.equal(probe.trace.at(-1), "native-session-close")
})

test("an unqualified parent image cannot activate a fresh Inspector or select a PID fallback", async t => {
  const probe = boundary(t, { unsupported: true })
  await assert.rejects(
    ParentInspector.connect(probe.proof, probe.connectOptions),
    /UNSUPPORTED_NODE_PROFILE/,
  )
  assert.equal(probe.activationCalls, 0)
  assert.equal(probe.socket, undefined)
  assert.equal(probe.trace.at(-1), "native-session-close")
})

test("new activation uses the held session once and closes its transport before authenticated endpoint cleanup", async t => {
  const probe = boundary(t)
  const session = await ParentInspector.connect(probe.proof, probe.connectOptions)
  assert.equal(session.opened, true)
  assert.equal(probe.activationCalls, 1)
  await session.identity()
  await session.close(probe.closeOwned)
  assert.ok(probe.trace.indexOf("websocket-closed") < probe.trace.indexOf("owned-ipc-close"))
  assert.ok(
    probe.trace.indexOf("owned-ipc-close") < probe.trace.lastIndexOf("native-session-close"),
  )
})

test("started-unconfirmed activation is retained as unknown without retry or Runtime commands", async t => {
  const probe = boundary(t, { activationUnknown: true })
  await assert.rejects(
    ParentInspector.connect(probe.proof, probe.connectOptions),
    error =>
      error instanceof AggregateError &&
      /未确认/.test(error.message) &&
      error.errors.some(item => /激活结果未确认/.test(item.message)),
  )
  assert.equal(probe.activationCalls, 1)
  assert.equal(probe.socket, undefined)
  assert.equal(probe.trace.at(-1), "native-session-close")
})

test("fresh confirmation refusal after WebSocket open prevents every Runtime request", async t => {
  const probe = boundary(t, { existing: true, confirmRefused: true })
  await assert.rejects(
    ParentInspector.connect(probe.proof, probe.connectOptions),
    /Held original parent/,
  )
  assert.equal(
    probe.trace.some(value => value.startsWith("runtime-send:")),
    false,
  )
  assert.ok(probe.trace.includes("websocket-closed"))
  assert.equal(probe.trace.at(-1), "native-session-close")
})

test("helper liveness loss blocks later Runtime operations without reopening by PID", async t => {
  const probe = boundary(t, { existing: true })
  const session = await ParentInspector.connect(probe.proof, probe.connectOptions)
  probe.die()
  await assert.rejects(session.evaluate("candidate mutation"), /Held original parent/)
  assert.equal(
    probe.trace.some(value => value.startsWith("runtime-send:")),
    false,
  )
  await session.close()
  assert.equal(probe.activationCalls, 0)
})

test("a native parent different from the preflight clue is refused before discovery or activation", async t => {
  const probe = boundary(t, { mismatchedParent: true })
  await assert.rejects(
    ParentInspector.connect(probe.proof, probe.connectOptions),
    /原生核验的 PM2 父进程与预检不符/,
  )
  assert.equal(probe.trace.includes("readonly-discover"), false)
  assert.equal(probe.activationCalls, 0)
  assert.equal(probe.trace.at(-1), "native-session-close")
})

test("an exhausted original deadline closes only the client and helper without a new budget", async t => {
  const probe = boundary(t, { existing: true, expireAfterDiscovery: true })
  await assert.rejects(ParentInspector.connect(probe.proof, probe.connectOptions), /PM2 接入超时/)
  assert.equal(probe.socket, undefined)
  assert.equal(probe.trace.filter(value => value.startsWith("native-open:")).length, 1)
  assert.equal(probe.activationCalls, 0)
  assert.equal(
    probe.trace.some(value => value.startsWith("runtime-send:")),
    false,
  )
})
