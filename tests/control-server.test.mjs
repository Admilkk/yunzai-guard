import assert from "node:assert/strict"
import net from "node:net"
import { once } from "node:events"
import test from "node:test"
import { createControlServer } from "../dist/host/control-server.js"

const token = "a".repeat(48)

/** 启动控制端点，记录收到的命令。 */
async function serve(t) {
  const calls = []
  const server = createControlServer({
    token,
    handle(command, message) {
      calls.push({ command, message })
      return { ok: true }
    },
  })
  t.after(() => server.close())
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return { calls, port: server.address().port }
}

/** 发送一行原始请求，返回应答文本；连接被断开时返回空串。 */
async function send(port, line) {
  const socket = net.connect({ host: "127.0.0.1", port })
  let reply = ""
  socket.setEncoding("utf8")
  socket.on("data", chunk => (reply += chunk))
  socket.on("error", () => {})
  await once(socket, "connect")
  socket.write(line)
  await once(socket, "close")
  return reply
}

test("control server passes input data from the console relay to the host", async t => {
  const { calls, port } = await serve(t)
  const data = "#状态\n".repeat(1000)
  const reply = await send(port, `${JSON.stringify({ token, command: "input", data })}\n`)
  assert.deepEqual(JSON.parse(reply), { ok: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, "input")
  assert.equal(calls[0].message.data, data)
})

test("control server rejects a wrong token, unknown commands and oversized requests", async t => {
  const { calls, port } = await serve(t)
  assert.equal(
    await send(port, `${JSON.stringify({ token: "b".repeat(48), command: "input", data: "x" })}\n`),
    "",
  )
  assert.equal(await send(port, `${JSON.stringify({ token, command: "shell" })}\n`), "")
  assert.equal(
    await send(port, `${JSON.stringify({ token, command: "input", data: "x".repeat(20000) })}\n`),
    "",
  )
  assert.equal(calls.length, 0)
})
