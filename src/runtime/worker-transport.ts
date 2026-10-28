import net from "node:net"
import { M } from "../shared/messages.js"

export interface WorkerTransportCounters {
  scope: "worker-to-native-control-only"
  evidence: "transport-callback-only"
  provenance: "guest-reported"
  offered: number
  accepted: number
  completed: number
  rejected: number
  unknown: number
  closed: number
}
/** 创建全零的线程传输计数。 */
export function createWorkerTransportCounters(): WorkerTransportCounters {
  return {
    scope: "worker-to-native-control-only",
    evidence: "transport-callback-only",
    provenance: "guest-reported",
    offered: 0,
    accepted: 0,
    completed: 0,
    rejected: 0,
    unknown: 0,
    closed: 0,
  }
}
let installedCounters: WorkerTransportCounters | undefined
/** 返回已安装的传输计数副本。 */
export function workerTransportStats(): WorkerTransportCounters | undefined {
  return installedCounters ? { ...installedCounters } : undefined
}
/** 计数包含管理和业务帧，不能与审计记录计数相加。 */
export function workerTransportIsIncomplete(counters: WorkerTransportCounters): boolean {
  return (
    counters.rejected > 0 ||
    counters.unknown > 0 ||
    counters.closed > 0 ||
    counters.accepted !== counters.completed
  )
}
/** 饱和加一。 */
const increment = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, value + 1)

/** 在进入实际队列前拒绝超限字节，同时保留 write 的布尔值和回调。 */
export function writeWorkerControlFrame(
  socket: Pick<net.Socket, "writable" | "destroyed" | "writableLength" | "write">,
  connected: boolean,
  message: unknown,
  counters: WorkerTransportCounters,
  callback?: (error?: Error | null) => void,
): boolean {
  counters.offered = increment(counters.offered)
  const refuse = (error: Error) => {
    counters.rejected = increment(counters.rejected)
    if (callback) callback(error)
    else throw error
    return false
  }
  if (!connected || !socket.writable || socket.destroyed) {
    counters.closed = increment(counters.closed)
    return refuse(new Error(M.runtime.pipeGone))
  }
  let line: string
  try {
    line = `${JSON.stringify(message)}\n`
  } catch (error) {
    return refuse(error instanceof Error ? error : new Error(String(error)))
  }
  const bytes = Buffer.byteLength(line)
  if (bytes > 65536) return refuse(new Error(M.runtime.pipeFrame))
  if (socket.writableLength + bytes > 256 * 1024) return refuse(new Error(M.runtime.pipeQueue))
  counters.accepted = increment(counters.accepted)
  let settled = false
  const complete = (error?: Error | null) => {
    if (settled) return
    settled = true
    if (error) counters.unknown = increment(counters.unknown)
    else counters.completed = increment(counters.completed)
    callback?.(error ?? null)
  }
  try {
    return socket.write(line, complete)
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    complete(failure)
    if (!callback) throw failure
    return false
  }
}

/** Windows AppContainer 使用经 Job 校验的命名管道，不继承 Node 原生 IPC。 */
export async function ensureWorkerTransport(): Promise<void> {
  if (process.send && process.connected) return
  const endpoint = process.env.YUNZAI_GUARD_PIPE
  if (process.platform !== "win32" || !endpoint?.startsWith("\\\\.\\pipe\\yunzai-guard-"))
    throw new Error(M.runtime.workerIpc)
  const socket = net.connect(endpoint)
  const counters = (installedCounters = createWorkerTransportCounters())
  socket.setEncoding("utf8")
  let connected = false
  let input = ""
  socket.on("error", () => {
    counters.unknown = increment(counters.unknown)
  })
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject)
    socket.once("connect", () => {
      connected = true
      resolve()
    })
    socket.setTimeout(5000, () => socket.destroy(new Error(M.runtime.pipeTimeout)))
  })
  socket.setTimeout(0)
  Object.defineProperty(process, "connected", { configurable: true, get: () => connected })
  process.send = ((message: unknown, ...args: unknown[]) => {
    const callback = args.find(value => typeof value === "function") as
      ((error?: Error | null) => void) | undefined
    return writeWorkerControlFrame(socket, connected, message, counters, callback)
  }) as typeof process.send
  process.disconnect = () => socket.destroy()
  socket.on("data", chunk => {
    input += chunk.toString("utf8")
    while (input.includes("\n")) {
      const split = input.indexOf("\n")
      const line = input.slice(0, split)
      input = input.slice(split + 1)
      if (Buffer.byteLength(line) > 65536) return void socket.destroy()
      try {
        process.emit("message", JSON.parse(line), undefined)
      } catch {
        socket.destroy()
        return
      }
    }
    if (Buffer.byteLength(input) > 65536) socket.destroy()
  })
  socket.once("close", () => {
    connected = false
    counters.closed = increment(counters.closed)
    process.emit("disconnect")
  })
}
