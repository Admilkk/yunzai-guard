import assert from "node:assert/strict"
import test from "node:test"
import net from "node:net"
import dgram from "node:dgram"
import dns from "node:dns"
import http2 from "node:http2"
import path from "node:path"
import os from "node:os"
import { parseSettings } from "../dist/config/index.js"
import { installInstrumentation } from "../dist/instrumentation/index.js"
import { filePath } from "../dist/instrumentation/descriptions.js"
import { once } from "node:events"

const deny = kind => parseSettings({ rules: [{ id: `deny-${kind}`, kind, action: "deny" }] })

test("listen and bind use the explicit listen kind", () => {
  const events = []
  const dispose = installInstrumentation(deny("listen"), event => events.push(event))
  try {
    assert.throws(() => net.createServer().listen(0, "127.0.0.1"), { code: "GUARD_DENIED" })
    assert.throws(() => net.createServer().listen("8080"), { code: "GUARD_DENIED" })
    const socket = dgram.createSocket("udp4")
    try {
      assert.throws(() => socket.bind(0, "127.0.0.1"), { code: "GUARD_DENIED" })
    } finally {
      socket.close()
    }
    const targets = events.filter(event => event.kind === "listen").map(event => event.target)
    assert.deepEqual(targets, ["tcp://127.0.0.1:0", "tcp://0.0.0.0:8080", "udp://127.0.0.1:0"])
  } finally {
    dispose()
  }
})

test("network and wildcard rules no longer reach listen, filesystem or native events", () => {
  for (const rule of [
    { id: "net", kind: "network", action: "deny" },
    { id: "all", kind: "*", action: "deny" },
    { id: "any", action: "deny" },
  ]) {
    const dispose = installInstrumentation(parseSettings({ rules: [rule] }), () => {})
    const server = net.createServer()
    try {
      server.listen(0, "127.0.0.1")
      dispose.observeFile("fs.writeFile", "/tmp/guard-explicit.txt", true)
    } finally {
      server.close()
      dispose()
    }
  }
})

test("dns queries and http2 are checked before execution", async () => {
  const events = []
  const dispose = installInstrumentation(deny("network"), event => events.push(event))
  try {
    assert.throws(() => dns.resolve4("example.invalid", () => {}), { code: "GUARD_DENIED" })
    assert.throws(() => new dns.Resolver().resolveTxt("example.invalid", () => {}), {
      code: "GUARD_DENIED",
    })
    await assert.rejects(dns.promises.resolveMx("example.invalid"), { code: "GUARD_DENIED" })
    assert.throws(() => http2.connect("https://example.invalid:8443/path?secret=1"), {
      code: "GUARD_DENIED",
    })
    const targets = Object.fromEntries(events.map(event => [event.operation, event.target]))
    assert.equal(targets["dns.resolve4"], "dns://example.invalid")
    assert.equal(targets["dns.resolveTxt"], "dns://example.invalid")
    assert.equal(targets["dns.resolveMx"], "dns://example.invalid")
    assert.equal(targets["http2.connect"], "https://example.invalid:8443/path")
  } finally {
    dispose()
  }
})

test("global WebSocket is checked as a constructor and restored on dispose", () => {
  if (typeof globalThis.WebSocket !== "function") return
  const before = globalThis.WebSocket
  const events = []
  const dispose = installInstrumentation(deny("network"), event => events.push(event))
  try {
    assert.throws(() => new WebSocket("wss://example.invalid/chat?token=1"), {
      code: "GUARD_DENIED",
    })
    assert.equal(
      events.find(event => event.operation === "WebSocket")?.target,
      "wss://example.invalid/chat",
    )
  } finally {
    dispose()
  }
  assert.equal(globalThis.WebSocket, before)
})

test("native addon loading is audited and can be denied", () => {
  const events = []
  const missing = path.join(os.tmpdir(), "guard-missing-addon.node")
  const dispose = installInstrumentation(deny("native"), event => events.push(event))
  try {
    assert.throws(() => process.dlopen({ exports: {} }, missing), { code: "GUARD_DENIED" })
    const event = events.find(event => event.operation === "native.load")
    assert.equal(event?.kind, "native")
    assert.equal(event?.target, missing)
  } finally {
    dispose()
  }
})

test("file observation follows monitor.files and keeps fd inputs out of targets", () => {
  for (const [files, expected] of [
    ["off", []],
    ["write", ["fs.writeFile"]],
    ["all", ["fs.writeFile", "fs.readFile"]],
  ]) {
    const events = []
    const dispose = installInstrumentation(parseSettings({ monitor: { files } }), event =>
      events.push(event),
    )
    try {
      dispose.observeFile("fs.writeFile", "/tmp/a.txt", true)
      dispose.observeFile("fs.readFile", Buffer.from("/tmp/b.txt"), false)
      dispose.observeFile("fs.createWriteStream", 7, true)
      const seen = events.filter(event => event.kind === "filesystem")
      assert.deepEqual(
        seen.map(event => event.operation),
        expected,
      )
      for (const event of seen) assert.equal(event.details.result, "attempt")
    } finally {
      dispose()
    }
  }
  const dispose = installInstrumentation(
    parseSettings({
      monitor: { files: "write" },
      rules: [{ id: "deny-files", kind: "filesystem", plugin: "unknown", action: "deny" }],
    }),
    () => {},
  )
  try {
    // 拒绝规则每次都要执行，不受重复记录抑制影响。
    for (let index = 0; index < 3; index++)
      assert.throws(() => dispose.observeFile("fs.unlink", "/tmp/c.txt", true), {
        code: "GUARD_DENIED",
      })
  } finally {
    dispose()
  }
})

test("repeated audited writes to the same file are recorded once per window", () => {
  const events = []
  const dispose = installInstrumentation(parseSettings({}), event => events.push(event))
  try {
    for (let index = 0; index < 5; index++)
      dispose.observeFile("fs.appendFile", "/tmp/log.txt", true)
    dispose.observeFile("fs.appendFile", "/tmp/other.txt", true)
    dispose.observeFile("fs.unlink", "/tmp/log.txt", true)
    assert.deepEqual(
      events.filter(event => event.kind === "filesystem").map(e => `${e.operation} ${e.target}`),
      ["fs.appendFile /tmp/log.txt", "fs.appendFile /tmp/other.txt", "fs.unlink /tmp/log.txt"],
    )
  } finally {
    dispose()
  }
})

test("monitor settings reject unknown values", () => {
  assert.equal(parseSettings({}).monitor.files, "write")
  assert.equal(parseSettings({}).monitor.process, true)
  assert.throws(() => parseSettings({ monitor: { process: "yes" } }))
  assert.throws(() => parseSettings({ monitor: { files: "everything" } }))
  assert.throws(() => parseSettings({ monitor: { extra: true } }))
})

test("net.connect and createConnection are recorded once and can still be denied", async () => {
  const server = net.createServer(socket => socket.destroy())
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address()
  const events = []
  const dispose = installInstrumentation(parseSettings({}), event => events.push(event))
  try {
    for (const connect of [net.connect, net.createConnection]) {
      const socket = connect(port, "127.0.0.1")
      await once(socket, "connect")
      socket.destroy()
    }
    assert.equal(events.filter(event => event.operation === "socket.connect").length, 2)
  } finally {
    dispose()
  }
  const denied = installInstrumentation(deny("network"), () => {})
  try {
    assert.throws(() => net.connect(port, "127.0.0.1"), { code: "GUARD_DENIED" })
  } finally {
    denied()
    server.close()
  }
})

test("Windows namespace prefixes are removed from recorded paths", () => {
  assert.equal(filePath("\\\\?\\C:\\yz\\plugins\\a\\addon.node"), "C:\\yz\\plugins\\a\\addon.node")
  assert.equal(filePath("\\\\?\\UNC\\server\\share\\a.node"), "\\\\server\\share\\a.node")
  assert.equal(filePath("/srv/yunzai/a.node"), "/srv/yunzai/a.node")
})
