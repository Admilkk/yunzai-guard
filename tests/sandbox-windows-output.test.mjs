import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { performance } from "node:perf_hooks"
import test from "node:test"
import { spawnWindowsSandbox } from "../dist/sandbox/windows.js"

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
test(
  "Windows native raw output goes to NUL while authenticated control IPC remains functional",
  { skip: process.platform !== "win32", timeout: 30000 },
  async t => {
    const runs = path.join(repository, "tests/runs")
    fs.mkdirSync(runs, { recursive: true })
    const root = fs.mkdtempSync(path.join(runs, "windows-output-null-"))
    fs.mkdirSync(path.join(root, "plugins/fixture"), { recursive: true })
    const program = path.join(root, "probe.cjs")
    fs.writeFileSync(
      program,
      `
    const fs=require('node:fs'),net=require('node:net');
    const socket=net.connect(process.env.YUNZAI_GUARD_PIPE);
    socket.once('connect',()=>socket.write(JSON.stringify({type:'preload-hello',pid:process.pid})+'\\n'));
    socket.once('data',()=>{
      const block=Buffer.alloc(64*1024,120);let bytes=0;
      for(let index=0;index<512;index++){bytes+=fs.writeSync(1,block);bytes+=fs.writeSync(2,block)}
      socket.write(JSON.stringify({type:'output-complete',bytes})+'\\n');
    });setInterval(()=>{},1000);
  `,
    )
    const child = spawnWindowsSandbox(
      root,
      { shutdownTimeout: 1000, sandbox: { network: "none", writablePaths: ["plugins/fixture"] } },
      {
        executable: process.execPath,
        args: [program],
        env: { ...process.env },
        forwardOutput: false,
      },
    )
    const errors = []
    let ready,
      reply,
      rawBytes = 0,
      payloadFrames = false,
      tail = ""
    child.on("error", error => errors.push(error.message))
    child.on("sandbox-ready", frame => {
      ready = frame
    })
    child.stdout.on("data", chunk => {
      rawBytes += Buffer.byteLength(chunk)
      const probe = tail + chunk
      if (/"type":"(?:stdout|stderr)"/.test(probe)) payloadFrames = true
      tail = probe.slice(-128)
    })
    child.on("message", message => {
      if (message.type === "preload-hello") child.send({ type: "run-benign-output-probe" })
      if (message.type === "output-complete") reply = message
    })
    try {
      const end = performance.now() + 15000
      while (!reply && !errors.length && performance.now() < end)
        await new Promise(resolve => setTimeout(resolve, 20))
      assert.deepEqual(errors, [])
      assert.equal(ready?.rawOutput, "nul")
      assert.equal(reply?.bytes, 64 * 1024 * 1024)
      assert.equal(payloadFrames, false, "Discarded bytes must never enter the broker JSON stream")
      assert.ok(rawBytes < 65536, `Control transport unexpectedly received ${rawBytes} bytes`)
      await child.sandboxDispose()
      assert.equal(fs.existsSync(child.sandboxSession), false)
      t.diagnostic(
        `NUL fixture retained at ${root}; ${rawBytes} control bytes for ${reply.bytes} discarded output bytes`,
      )
    } finally {
      await child.sandboxDispose()
    }
  },
)
