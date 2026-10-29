import fs from "node:fs"
import path from "node:path"
import net from "node:net"
import { maxRequestBytes } from "./control-server.js"
import { stateDir } from "../shared/identity.js"
import { M } from "../shared/messages.js"

// 单段输入 JSON 编码后的上限，为令牌与命令字段留出余量。
const inputBytes = maxRequestBytes / 2

/**
 * 把控制台输入按行切开，超长的行再按 JSON 编码后的字节数分段，不拆开代理对，
 * 确保每个 input 请求都在控制端点的大小上限内。
 */
export function splitInput(text: string): string[] {
  const parts: string[] = []
  for (const line of text.replace(/\r\n/g, "\n").split(/(?<=\n)/)) {
    let part = ""
    let size = 0
    for (const char of line) {
      const bytes = Buffer.byteLength(JSON.stringify(char)) - 2
      if (part && size + bytes > inputBytes) {
        parts.push(part)
        part = ""
        size = 0
      }
      part += char
      size += bytes
    }
    if (part) parts.push(part)
  }
  return parts
}

/**
 * 管理命令不读取待生效的配置，配置写坏时仍可停止或恢复现有宿主。
 * extra 为命令附带的字段，例如 input 的 data；读不到控制信息时返回被拒绝的 Promise。
 */
export function request(command: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const { token, port } = JSON.parse(
      fs.readFileSync(path.join(stateDir, "control.json"), "utf8"),
    ) as { token: string; port: number }
    const socket = net.connect({ host: "127.0.0.1", port })
    let data = ""
    socket.setTimeout(5000, () => socket.destroy(new Error(M.host.controlTimeout)))
    socket.on("error", reject)
    socket.on("connect", () => socket.write(`${JSON.stringify({ ...extra, token, command })}\n`))
    socket.on("data", chunk => {
      data += chunk
      if (Buffer.byteLength(data) > 1024 * 1024)
        return socket.destroy(new Error(M.host.controlTooLarge))
      if (data.includes("\n")) {
        socket.end()
        try {
          resolve(JSON.parse(data.split("\n")[0]))
        } catch (error) {
          reject(error)
        }
      }
    })
    socket.on("end", () => {
      if (!data.includes("\n")) reject(new Error(M.host.controlIncomplete))
    })
  })
}
