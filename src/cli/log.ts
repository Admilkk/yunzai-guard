import fs from "node:fs"
import path from "node:path"
import { stateDir } from "../shared/identity.js"
import { M } from "../shared/messages.js"

const maxLogBytes = 4 * 1024 * 1024
const pollInterval = 500

/** 返回宿主日志文件路径。 */
function hostLogPath(): string {
  return path.join(stateDir, "host.log")
}

/** 读取当前日志内容；文件尚未生成时返回空串。 */
function readTail(): string {
  try {
    const info = fs.statSync(hostLogPath())
    const size = Math.min(info.size, maxLogBytes)
    const handle = fs.openSync(hostLogPath(), "r")
    try {
      const buffer = Buffer.alloc(size)
      fs.readSync(handle, buffer, 0, size, info.size - size)
      return buffer.toString("utf8")
    } finally {
      fs.closeSync(handle)
    }
  } catch {
    return ""
  }
}

/** 简单轮转检测：inode/大小回退即整体重打印。 */
async function logCommand(_args: string[]): Promise<void> {
  const file = hostLogPath()
  console.error(M.cli.following(file))
  let printed = ""
  let rotation = ""
  const follow = (): void => {
    try {
      const info = fs.statSync(file)
      const current = `${info.size}:${info.mtimeMs}`
      if (current === rotation) return
      rotation = current
      const text = readTail()
      if (text.startsWith(printed)) {
        process.stdout.write(text.slice(printed.length))
      } else {
        process.stdout.write(text)
      }
      printed = text
    } catch {
      // 文件尚未生成，继续等待。
    }
  }
  follow()
  const timer = setInterval(follow, pollInterval)
  const stop = (): void => {
    clearInterval(timer)
    process.exit(0)
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  // 保持进程存活直到用户中断。
  await new Promise(() => {})
}

export { logCommand }
