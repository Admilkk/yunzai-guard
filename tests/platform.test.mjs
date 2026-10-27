import assert from "node:assert/strict"
import { test } from "node:test"
import net from "node:net"
import { spawn } from "node:child_process"
import {
  capabilities,
  assertPlatform,
  prepareDescendantCapture,
  captureDescendants,
  terminateWorkerTree,
  hasExited,
} from "../dist/host/platform.js"

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test("supported platform capabilities never advertise an OS sandbox", () => {
  for (const platform of ["win32", "linux", "android"]) {
    const result = capabilities(platform)
    assert.equal(result.platform, platform)
    assert.equal(result.supported, true)
    assert.equal(result.osSandbox, false)
    assert.equal(result.isolation, "managed-process")
    assert.ok(result.limitations.length >= 2)
    assert.doesNotThrow(() => assertPlatform("managed", platform))
    if (platform === "android")
      assert.throws(() => assertPlatform("os-sandbox", platform), /unavailable/)
    else {
      assert.doesNotThrow(() => assertPlatform("os-sandbox", platform))
      assert.equal(capabilities(platform, "os-sandbox").osSandbox, true)
    }
  }
  assert.equal(capabilities("win32").processTree, "identity-checked-snapshot")
  assert.equal(capabilities("linux").processTree, "process-group")
})

test("macOS and unsupported platforms fail explicitly", () => {
  for (const platform of ["darwin", "freebsd", "openbsd"]) {
    assert.equal(capabilities(platform).supported, false)
    assert.equal(capabilities(platform).processTree, "unsupported")
    assert.throws(() => assertPlatform("managed", platform), /不支持的平台/)
  }
})

test(
  "a stale Unix worker identity cannot signal a live reused process group",
  {
    skip: !["linux", "android"].includes(process.platform),
    timeout: 10000,
  },
  async () => {
    const unrelatedGroup = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
    })
    try {
      await new Promise((resolve, reject) => {
        unrelatedGroup.once("spawn", resolve)
        unrelatedGroup.once("error", reject)
      })
      // 模拟已回收 Worker 的 PID 被无关进程组复用。
      const stale = { pid: unrelatedGroup.pid, exitCode: 0, signalCode: null }
      await assert.rejects(terminateWorkerTree(stale, []), /无法证明进程组归属/)
      assert.equal(hasExited(unrelatedGroup), false)
      assert.doesNotThrow(() => process.kill(unrelatedGroup.pid, 0))
    } finally {
      await terminateWorkerTree(unrelatedGroup, [])
    }
  },
)

function reachable(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port })
    const finish = value => {
      socket.destroy()
      resolve(value)
    }
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
    socket.setTimeout(500, () => finish(false))
  })
}

test(
  "managed worker and grandchild release resources while an unrelated child survives",
  {
    skip: !capabilities().supported,
    timeout: 30000,
  },
  async () => {
    const grandchildCode = `
    import net from 'node:net'
    const server = net.createServer(socket => socket.end())
    server.listen(0, '127.0.0.1', () => process.send({pid:process.pid, port:server.address().port}))
  `
    const workerCode = `
    import {spawn} from 'node:child_process'
    const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(grandchildCode)}],
      {stdio:['ignore','ignore','ignore','ipc'], windowsHide:true})
    child.on('message', value => process.send(value))
    setInterval(() => {}, 1000)
  `
    const worker = spawn(process.execPath, ["--input-type=module", "-e", workerCode], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      detached: process.platform !== "win32",
      windowsHide: true,
    })
    prepareDescendantCapture(worker)
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    })
    let identities = []
    try {
      const grandchild = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Grandchild did not start")), 5000)
        worker.once("error", reject)
        worker.once("message", value => {
          clearTimeout(timer)
          resolve(value)
        })
      })
      assert.ok(Number.isInteger(grandchild.pid))
      assert.equal(await reachable(grandchild.port), true)
      identities = await captureDescendants(worker)
      if (process.platform === "win32") {
        assert.equal(hasExited(worker), false)
        assert.equal(
          identities.some(item => item.pid === worker.pid),
          false,
        )
        assert.ok(identities.some(item => item.pid === grandchild.pid))
        // 复用或不匹配的身份不能成为终止目标。
        identities.push({ pid: unrelated.pid, created: "20000101000000000" })
      }
      await terminateWorkerTree(worker, identities)
      assert.equal(hasExited(worker), true)
      for (let attempt = 0; attempt < 20 && (await reachable(grandchild.port)); attempt++)
        await sleep(25)
      assert.equal(await reachable(grandchild.port), false)
      assert.equal(hasExited(unrelated), false)
      assert.doesNotThrow(() => process.kill(unrelated.pid, 0))
    } finally {
      if (!hasExited(worker)) {
        try {
          await terminateWorkerTree(worker, identities)
        } catch {
          worker.kill("SIGKILL")
        }
      }
      unrelated.kill("SIGKILL")
    }
  },
)
