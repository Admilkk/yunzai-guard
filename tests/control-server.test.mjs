import assert from "node:assert/strict"
import net from "node:net"
import { once } from "node:events"
import test from "node:test"
import { createControlServer } from "../dist/host/control-server.js"
import { splitInput } from "../dist/host/control.js"

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

test("console input is split so every input request stays within the control server limit", async t => {
  const { calls, port } = await serve(t)
  // 控制字符 JSON 编码后每个占 6 字节，按字符数分段会超出上限。
  const controls = "\u0001".repeat(6000)
  const emoji = "😀".repeat(5000)
  const text = `#状态\r\n${controls}${emoji}\n尾巴`
  const parts = splitInput(text)
  assert.equal(parts.join(""), text.replace(/\r\n/g, "\n"))
  assert.equal(parts[0], "#状态\n")
  assert.equal(parts.at(-1), "尾巴")
  for (const data of parts) {
    // 分段不拆开代理对。
    assert.equal(data.isWellFormed(), true)
    const reply = await send(port, `${JSON.stringify({ token, command: "input", data })}\n`)
    assert.deepEqual(JSON.parse(reply), { ok: true })
  }
  assert.equal(calls.map(call => call.message.data).join(""), text.replace(/\r\n/g, "\n"))
})
