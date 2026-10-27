import assert from "node:assert/strict"
import test from "node:test"
import net from "node:net"
import { spawn } from "node:child_process"
import { once } from "node:events"
import {
  decodeProcAddress,
  endpoint,
  isLoopback,
  parseProcTcp,
  sampleUsage,
  UsageWatch,
} from "../dist/host/usage.js"

test("proc tcp addresses decode for IPv4, IPv6 and mapped IPv4", () => {
  assert.equal(decodeProcAddress("0100007F"), "127.0.0.1")
  assert.equal(decodeProcAddress("0101A8C0"), "192.168.1.1")
  assert.equal(decodeProcAddress("00000000000000000000000001000000"), "::1")
  assert.equal(decodeProcAddress("0000000000000000FFFF00000100007F"), "::ffff:127.0.0.1")
  assert.equal(decodeProcAddress("B80D0120000000000000000001000000"), "2001:db8::1")
  assert.equal(decodeProcAddress("zz"), undefined)
})

test("proc tcp table keeps only established sockets keyed by inode", () => {
  const table = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1",
    "   1: 0101A8C0:C350 0202A8C0:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 222 1",
  ].join("\n")
  const parsed = parseProcTcp(table)
  assert.deepEqual([...parsed.keys()], ["222"])
  assert.deepEqual(parsed.get("222"), { address: "192.168.2.2", port: 443 })
})

test("endpoint formatting and loopback detection", () => {
  assert.equal(endpoint("1.2.3.4", 443), "1.2.3.4:443")
  assert.equal(endpoint("2001:db8::1", 443), "[2001:db8::1]:443")
  for (const value of ["127.0.0.1", "127.8.0.1", "::1", "::ffff:127.0.0.1"])
    assert.equal(isLoopback(value), true)
  for (const value of ["10.0.0.1", "2001:db8::1", "::ffff:10.0.0.1"])
    assert.equal(isLoopback(value), false)
})

test("unsupported or exited roots return no sample", async () => {
  assert.equal(await sampleUsage(0), undefined)
  assert.equal(await sampleUsage(-5), undefined)
  assert.equal(await sampleUsage(2 ** 31 - 2), undefined)
})

test(
  "a live child holding a loopback connection is sampled from outside the process",
  { skip: !["linux", "win32"].includes(process.platform), timeout: 60000 },
  async () => {
    const server = net.createServer(socket => socket.on("error", () => {}))
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const { port } = server.address()
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const s=require("net").connect(${port},"127.0.0.1",()=>process.stdout.write("ready"));s.on("error",()=>{});setInterval(()=>{},1000)`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    )
    try {
      await once(child.stdout, "data")
      const usage = await sampleUsage(child.pid)
      assert.ok(usage, "sample should exist while the child is alive")
      assert.ok(usage.processes >= 1)
      assert.ok(usage.loopback >= 1, `loopback connections: ${usage.loopback}`)
      assert.deepEqual(usage.remote, [])
      const seen = []
      const watch = new UsageWatch(child.pid, remote => seen.push(remote))
      assert.ok(await watch.sample())
      assert.equal(watch.latest.processes, usage.processes)
      assert.deepEqual(seen, [])
      watch.stop()
    } finally {
      child.kill()
      server.close()
    }
  },
)
