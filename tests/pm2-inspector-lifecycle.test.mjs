import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import test from "node:test"

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, description, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await pause(5)
  }
  throw new Error(description)
}

// 回归 Inspector 与 WebSocket 关闭竞争导致 Node 24 Linux PM2 中止的问题；调用方收到 WebSocket close 后，再通过父进程 IPC 请求目标关闭 Inspector。
test(
  "native Inspector survives 64 activation and IPC-close cycles after WebSocket disconnect",
  { skip: !["win32", "linux"].includes(process.platform), timeout: 90000 },
  async () => {
    const script = `
const inspector = require("node:inspector");
process.on("message", message => {
  if (message.type === "stop") process.exit(0);
  if (message.type !== "close") return;
  if (inspector.url() !== message.url) throw new Error("Inspector ownership mismatch");
  inspector.close();
  process.send({type:"closed",nonce:message.nonce,inactive:inspector.url()===undefined});
});
setInterval(()=>{},1000);
process.send({type:"ready"});
`
    const env = { ...process.env }
    delete env.NODE_OPTIONS
    delete env.PM2_NODE_OPTIONS
    const child = spawn(process.execPath, ["--inspect-port=0", "-e", script], {
      env,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    })
    const exit = once(child, "exit")
    let stderr = ""
    const messages = []
    child.stderr.on("data", chunk => {
      stderr += chunk
    })
    child.on("message", message => messages.push(message))
    try {
      await until(
        () => messages.some(message => message.type === "ready"),
        "Owned target not ready",
      )
      for (let cycle = 0; cycle < 64; cycle++) {
        const offset = stderr.length
        process._debugProcess(child.pid)
        const url = await until(
          () => /Debugger listening on (ws:\/\/[^\s]+)/.exec(stderr.slice(offset))?.[1],
          "Owned target did not open its Inspector",
        )
        const socket = new WebSocket(url)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Owned Inspector connection timeout")),
            5000,
          )
          socket.addEventListener(
            "open",
            () => {
              clearTimeout(timer)
              resolve()
            },
            { once: true },
          )
          socket.addEventListener(
            "error",
            () => {
              clearTimeout(timer)
              reject(new Error("Owned Inspector connection failed"))
            },
            { once: true },
          )
        })
        const response = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Owned Runtime response timeout")), 5000)
          socket.addEventListener("message", event => {
            const value = JSON.parse(event.data)
            if (value.id !== 1) return
            clearTimeout(timer)
            resolve(value)
          })
        })
        socket.send(
          JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: {
              expression: "({pid:process.pid})",
              returnByValue: true,
              awaitPromise: true,
            },
          }),
        )
        const value = await response
        assert.equal(value.result.result.value.pid, child.pid)
        const disconnected = new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Owned WebSocket disconnect timeout")),
            5000,
          )
          socket.addEventListener(
            "close",
            () => {
              clearTimeout(timer)
              resolve()
            },
            { once: true },
          )
        })
        socket.close()
        await disconnected
        child.send({ type: "close", nonce: cycle, url })
        const receipt = await until(
          () => messages.find(message => message.type === "closed" && message.nonce === cycle),
          "Owned IPC close receipt missing",
        )
        assert.equal(receipt.inactive, true)
        assert.equal(child.exitCode, null, "Closing Inspector must not abort its owning process")
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.send({ type: "stop" }, () => {})
        const timer = setTimeout(() => child.kill("SIGKILL"), 2000)
        await exit
        clearTimeout(timer)
      }
    }
    assert.equal(child.exitCode, 0)
  },
)
