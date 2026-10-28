import net from "node:net"
import { timingSafeEqual } from "node:crypto"
import { M } from "../shared/messages.js"

export const controlCommands = [
  "status",
  "restart",
  "stop",
  "resume",
  "invoke-bot-restart",
  "check-update",
  "update",
  "force-update",
  "rollback",
] as const
export type ControlCommand = (typeof controlCommands)[number]

interface ControlServerOptions {
  /** 每代宿主随机生成的令牌，只写入 0600 的 control.json。 */
  token: string
  /** 认证通过后执行命令，返回值作为应答。 */
  handle: (command: ControlCommand) => unknown
  /** 应答发出后再执行的动作，例如 stop。 */
  after?: (command: ControlCommand) => void
}

const maxConnections = 32
const maxRequestBytes = 2048
const idleTimeoutMs = 2000

/**
 * 本机 CLI 控制端点：单行 JSON 请求，常量时间比较令牌。
 * 任何格式、认证或命令错误都直接断开，不回传原因。
 */
export function createControlServer({ token, handle, after }: ControlServerOptions): net.Server {
  const sockets = new Set<net.Socket>()
  const expected = Buffer.from(token)
  return net.createServer(socket => {
    if (sockets.size >= maxConnections) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    let text = ""
    let answered = false
    socket.setTimeout(idleTimeoutMs, () => socket.destroy())
    socket.on("error", () => {})
    socket.once("close", () => sockets.delete(socket))
    socket.on("data", (chunk: Buffer) => {
      if (answered) return
      text += chunk.toString("utf8")
      if (Buffer.byteLength(text) > maxRequestBytes) {
        socket.destroy()
        return
      }
      if (!text.includes("\n")) return
      answered = true
      try {
        const raw: unknown = JSON.parse(text.split("\n")[0])
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new Error(M.host.commandInvalid)
        const message = raw as Record<string, unknown>
        if (typeof message.token !== "string") throw new Error(M.host.credential)
        const received = Buffer.from(message.token)
        if (received.length !== expected.length || !timingSafeEqual(received, expected))
          throw new Error(M.host.credential)
        const command = message.command
        if (typeof command !== "string" || !controlCommands.includes(command as ControlCommand))
          throw new Error(M.host.commandUnknown)
        socket.end(`${JSON.stringify(handle(command as ControlCommand))}\n`)
        after?.(command as ControlCommand)
      } catch {
        socket.destroy()
      }
    })
  })
}
