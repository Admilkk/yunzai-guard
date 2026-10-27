import assert from "node:assert/strict"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { randomUUID } from "node:crypto"
import { performance } from "node:perf_hooks"
import test from "node:test"

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const enabled =
  process.platform === "linux" &&
  process.env.GUARD_ECOSYSTEM_CONTAINER === "1" &&
  process.env.GUARD_TEST_NATIVE_UNIX_SOCKET === "1"

test(
  "native network:none cannot reach a host pathname Unix socket exposed beneath its read-only project",
  {
    skip: enabled ? false : "requires isolated Linux container and GUARD_TEST_NATIVE_UNIX_SOCKET=1",
    timeout: 45000,
  },
  async t => {
    const runs = path.join(repository, "tests/runs")
    const base = process.env.GUARD_NATIVE_PROBE_ROOT || runs
    fs.mkdirSync(runs, { recursive: true })
    fs.mkdirSync(base, { recursive: true })
    const root = fs.mkdtempSync(path.join(base, "nux-"))
    const guard = path.join(root, "plugins/yunzai-guard")
    const pluginRoot = path.join(root, "plugins/socket-probe")
    fs.mkdirSync(guard, { recursive: true })
    fs.mkdirSync(pluginRoot, { recursive: true })
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}')
    fs.cpSync(path.join(repository, "dist"), path.join(guard, "dist"), { recursive: true })
    const socketPath = path.join(root, "echo.sock")
    assert.ok(
      Buffer.byteLength(socketPath) < 104,
      "Fixture pathname must fit sockaddr_un without truncation",
    )
    const nonce = randomUUID(),
      sockets = new Set()
    let accepted = 0,
      session
    const server = net.createServer(socket => {
      accepted++
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
      socket.on("error", () => {})
      socket.once("data", chunk => socket.end(chunk.subarray(0, 128)))
    })
    const evidence = {
      root,
      network: "none",
      socketPath,
      node: process.version,
      baseline: false,
      accepted: 0,
      result: null,
    }
    const report = path.join(runs, `native-unix-socket-${path.basename(root)}.json`)
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(socketPath, resolve)
      })
      const baseline = await new Promise((resolve, reject) => {
        const socket = net.connect(socketPath)
        socket.setTimeout(1500, () => socket.destroy(new Error("baseline timeout")))
        socket.once("error", reject)
        socket.once("connect", () => socket.write(nonce))
        socket.once("data", chunk => {
          socket.destroy()
          resolve(chunk.toString())
        })
      })
      assert.equal(baseline, nonce)
      evidence.baseline = true
      accepted = 0
      const entry = path.join(root, "probe.mjs")
      fs.writeFileSync(
        entry,
        `
      import net from 'node:net';
      process.on('message',message=>{if(message.type!=='probe')return;
        const socket=net.connect(message.path);let finished=false;
        const finish=result=>{if(finished)return;finished=true;socket.destroy();process.send({type:'probe-result',...result})};
        socket.setTimeout(1500,()=>finish({connected:false,code:'TIMEOUT'}));
        socket.on('error',error=>finish({connected:false,code:error.code}));
        socket.once('connect',()=>socket.write(message.nonce));
        socket.once('data',chunk=>finish({connected:true,echo:chunk.toString()}));
      });process.send({type:'fixture-ready'});
    `,
      )
      const { launchNativeSandbox } = await import(
        pathToFileURL(path.join(guard, "dist/native-sandbox/launch.js")).href
      )
      session = await launchNativeSandbox({ root, pluginRoot, entry, network: "none" })
      const observations = []
      session.child.on("message", message => observations.push(message))
      session.child.on("error", error =>
        observations.push({ type: "error", message: error.message }),
      )
      await session.ready
      const wait = async predicate => {
        const end = performance.now() + 10000
        while (performance.now() < end) {
          if (predicate()) return
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        throw new Error(`Socket fixture timeout: ${JSON.stringify(observations)}`)
      }
      await wait(() => observations.some(message => message.type === "fixture-ready"))
      session.child.send({ type: "probe", path: socketPath, nonce })
      await wait(() => observations.some(message => message.type === "probe-result"))
      evidence.result = observations.find(message => message.type === "probe-result")
      evidence.accepted = accepted
      assert.equal(
        evidence.result.connected,
        false,
        "network:none must not silently retain access to host pathname sockets",
      )
      assert.equal(accepted, 0, "The host echo service must see no sandbox connection")
    } finally {
      try {
        await session?.close()
      } finally {
        for (const socket of sockets) socket.destroy()
        if (server.listening) await new Promise(resolve => server.close(resolve))
        evidence.accepted = accepted
        fs.writeFileSync(report, JSON.stringify(evidence, null, 2))
        t.diagnostic(`Benign socket evidence: ${report}; fixture retained at ${root}`)
      }
    }
  },
)
