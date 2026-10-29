import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import test from "node:test"

const relayScript = fileURLToPath(new URL("../dist/entry/console.js", import.meta.url))

/** 启动一个只负责存活的假宿主。 */
function fakeHost(t) {
  const host = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  })
  t.after(() => host.kill())
  return host
}

/** 等待转印输出满足条件。 */
async function until(read, check, label, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check(read())) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail(`等待超时：${label}，实际输出：${JSON.stringify(read())}`)
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "guard-console-relay-"))
  const stateDir = path.join(root, "data", "yunzai-guard")
  fs.mkdirSync(stateDir, { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, stateDir, log: path.join(stateDir, "host.log") }
}

/** 以给定宿主与起点启动转印进程。 */
function startRelay(t, root, hostPid, offset, ...extra) {
  const relay = spawn(process.execPath, [relayScript, String(hostPid), String(offset), ...extra], {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  })
  t.after(() => relay.kill())
  const chunks = []
  relay.stdout.on("data", chunk => chunks.push(chunk))
  return { relay, read: () => Buffer.concat(chunks).toString("utf8") }
}

test("console relay prints new host output, follows rotation and exits with the host", async t => {
  const { root, log } = fixture(t)
  fs.writeFileSync(log, "before\n")
  const host = fakeHost(t)
  const { relay, read } = startRelay(t, root, host.pid, fs.statSync(log).size)
  fs.appendFileSync(log, "first\n")
  await until(read, text => text === "first\n", "首段输出")

  // 模拟宿主轮转：尾部移到 host.log.1 后重新创建，一个多字节字符被切在两份文件之间。
  const split = Buffer.from("中")
  fs.appendFileSync(log, Buffer.concat([Buffer.from("tail "), split.subarray(0, 2)]))
  fs.writeFileSync(`${log}.1`, fs.readFileSync(log))
  fs.unlinkSync(log)
  fs.writeFileSync(log, Buffer.concat([split.subarray(2), Buffer.from("\nnew\n")]))
  await until(read, text => text.endsWith("new\n"), "轮转后输出")
  assert.equal(read(), "first\ntail 中\nnew\n")

  const exited = once(relay, "exit")
  host.kill()
  const [code] = await exited
  assert.equal(code, 0)
})

test("console relay follows the relaunched host during a host update", async t => {
  const { root, stateDir, log } = fixture(t)
  const first = fakeHost(t)
  const { relay, read } = startRelay(t, root, first.pid, 0)
  fs.writeFileSync(path.join(stateDir, "update-verify.json"), "{}")
  const exitedFirst = once(first, "exit")
  first.kill()
  await exitedFirst
  await new Promise(resolve => setTimeout(resolve, 600))
  assert.equal(relay.exitCode, null)

  const second = fakeHost(t)
  fs.writeFileSync(
    path.join(stateDir, "control.json"),
    JSON.stringify({ token: "x", port: 1, hostPid: second.pid, projectId: "0" }),
  )
  fs.appendFileSync(log, "relaunched\n")
  await until(read, text => text === "relaunched\n", "新宿主输出")
  fs.rmSync(path.join(stateDir, "update-verify.json"))
  await new Promise(resolve => setTimeout(resolve, 600))
  assert.equal(relay.exitCode, null, "新宿主运行期间不应退出")

  const exited = once(relay, "exit")
  second.kill()
  const [code] = await exited
  assert.equal(code, 0)
})

test("console relay reports readiness on the given pipe", async t => {
  const { root } = fixture(t)
  const host = fakeHost(t)
  const pipe =
    process.platform === "win32"
      ? `\\\\.\\pipe\\guard-console-test-${process.pid}`
      : path.join(root, "ready.sock")
  const server = net.createServer()
  t.after(() => server.close())
  await new Promise(resolve => server.listen(pipe, resolve))
  const connected = once(server, "connection")
  const { relay } = startRelay(t, root, host.pid, 0, pipe)
  const [socket] = await connected
  let report = ""
  socket.setEncoding("utf8")
  socket.on("data", chunk => (report += chunk))
  await once(socket, "end")
  // 没有原进程与控制台可暂停时只转印输出。
  assert.equal(report, "plain\n")
  // 结束宿主后转印进程自行退出，再清理它所在的目录。
  const exited = once(relay, "exit")
  host.kill()
  await exited
})

// Windows 上 process.kill 发 SIGINT 等同强制结束，真实 Ctrl+C 已在控制台窗口中验证。
test(
  "console relay asks the host to stop on Ctrl+C and keeps printing until it exits",
  { skip: process.platform === "win32" },
  async t => {
    const { root, stateDir, log } = fixture(t)
    const host = fakeHost(t)
    const commands = []
    const server = net.createServer(socket =>
      socket.on("data", chunk => {
        commands.push(JSON.parse(String(chunk).split("\n")[0]))
        socket.end('{"ok":true}\n')
        fs.appendFileSync(log, "host stopped\n")
        setTimeout(() => host.kill(), 300)
      }),
    )
    t.after(() => server.close())
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
    fs.writeFileSync(
      path.join(stateDir, "control.json"),
      JSON.stringify({
        token: "t",
        port: server.address().port,
        hostPid: host.pid,
        projectId: "0",
      }),
    )
    const { relay, read } = startRelay(t, root, host.pid, 0)
    await new Promise(resolve => setTimeout(resolve, 500))
    const exited = once(relay, "exit")
    relay.kill("SIGINT")
    const [code] = await exited
    assert.equal(code, 0)
    assert.deepEqual(commands, [{ token: "t", command: "stop" }])
    assert.match(read(), /正在停止机器人[\s\S]*host stopped\n$/)
  },
)
