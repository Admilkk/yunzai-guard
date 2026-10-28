import type { ChildProcess } from "node:child_process"
import type { Duplex } from "node:stream"
import { performance } from "node:perf_hooks"
import { M } from "../shared/messages.js"

export const maxTransportFrameBytes = 64 * 1024

type IngressKind =
  "frame" | "bytes" | "log" | "diagnostic" | "hook" | "task" | "adapter" | "behavior" | "bot-events"
const ingressLimits: Record<IngressKind, { burst: number; refill: number }> = {
  frame: { burst: 4096, refill: 512 },
  bytes: { burst: 8 * 1024 * 1024, refill: 1024 * 1024 },
  log: { burst: 1024, refill: 32 },
  diagnostic: { burst: 64, refill: 2 },
  hook: { burst: 256, refill: 16 },
  task: { burst: 64, refill: 8 },
  adapter: { burst: 256, refill: 64 },
  behavior: { burst: 512, refill: 128 },
  "bot-events": { burst: 256, refill: 64 },
}

/** 每会话令牌桶允许启动突发，不放任宿主工作量，也不设置生命周期累计限额。 */
export class NativeIngressBudget {
  private stopped = false
  private readonly buckets: Record<IngressKind, { tokens: number; updated: number }>

  /** 创建入站配额计数器。 */
  constructor(private readonly now: () => number = () => performance.now()) {
    const time = now()
    if (!Number.isFinite(time)) throw new TypeError(M.nativeSandbox.ingressClock)
    this.buckets = Object.fromEntries(
      Object.entries(ingressLimits).map(([kind, limit]) => [
        kind,
        { tokens: limit.burst, updated: time },
      ]),
    ) as typeof this.buckets
  }

  /** 是否已因超额封闭。 */
  get sealed(): boolean {
    return this.stopped
  }

  /** 消耗指定类型的配额，超额时封闭。 */
  consume(kind: IngressKind, amount = 1): void {
    const reject = (): never => {
      this.stopped = true
      throw Object.assign(new Error(M.nativeSandbox.ingressLimit), {
        code: "NATIVE_INGRESS_LIMIT",
      })
    }
    if (
      this.stopped ||
      !Object.hasOwn(ingressLimits, kind) ||
      !Number.isSafeInteger(amount) ||
      amount < 0
    )
      reject()
    const time = this.now()
    if (!Number.isFinite(time)) reject()
    const bucket = this.buckets[kind],
      limit = ingressLimits[kind]
    const updated = Math.max(bucket.updated, time)
    bucket.tokens = Math.min(
      limit.burst,
      bucket.tokens + ((updated - bucket.updated) * limit.refill) / 1000,
    )
    bucket.updated = updated
    if (amount > bucket.tokens) reject()
    bucket.tokens -= amount
  }
}

/** 原生 Node JSON IPC 以换行分帧，解码或 JSON.parse 前先限制字节数。 */
export class BoundedJsonLines {
  private pending: Buffer[] = []
  private pendingBytes = 0
  private failed = false
  private readonly decoder = new TextDecoder("utf-8", { fatal: true })
  /** 创建按行解析的帧读取器。 */
  constructor(
    private readonly message: (value: unknown) => void,
    private readonly failure: (error: Error) => void,
    private readonly limit = maxTransportFrameBytes,
    private readonly budget = new NativeIngressBudget(),
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new TypeError(M.nativeSandbox.frameLimitValue)
  }

  /** 以错误中止读取。 */
  private abort(error: Error): void {
    if (this.failed) return
    this.failed = true
    this.pending = []
    this.pendingBytes = 0
    this.failure(error)
  }

  /** 写入一段数据并解析完整帧。 */
  write(chunk: Buffer): void {
    if (this.failed) return
    try {
      this.budget.consume("bytes", chunk.length)
    } catch (error) {
      this.abort(error as Error)
      return
    }
    let offset = 0
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset)
      const boundary = end < 0 ? chunk.length : end
      const length = boundary - offset
      if (this.pendingBytes + length > this.limit) {
        this.abort(new Error(M.nativeSandbox.rawFrameTooLarge))
        return
      }
      const part = chunk.subarray(offset, boundary)
      if (end < 0) {
        if (this.pending.length >= 1024) {
          this.abort(new Error(M.nativeSandbox.fragmentation))
          return
        }
        // 每个分片只复制一次，避免大量微小写入反复拼接导致平方级复制。
        this.pending.push(Buffer.from(part))
        this.pendingBytes += length
        return
      }
      const frame = this.pending.length
        ? Buffer.concat([...this.pending, part], this.pendingBytes + length)
        : part
      this.pending = []
      this.pendingBytes = 0
      try {
        this.budget.consume("frame")
        const value: unknown = JSON.parse(this.decoder.decode(frame))
        if (
          value &&
          typeof value === "object" &&
          typeof (value as { cmd?: unknown }).cmd === "string" &&
          (value as { cmd: string }).cmd.startsWith("NODE_")
        )
          throw new Error(M.nativeSandbox.internalInbound)
        this.message(value)
      } catch (error) {
        this.abort(error instanceof Error ? error : new Error(M.nativeSandbox.ipcFrame))
        return
      }
      offset = end + 1
    }
  }

  /** 结束读取，残留数据视为错误。 */
  end(): void {
    if (this.pendingBytes) this.abort(new Error(M.nativeSandbox.incompleteFrame))
  }
}

/** 仅父进程使用，FD 3 为普通管道，避免 Node 代为解析无界子进程 IPC。 */
export function attachNativeTransport(
  child: ChildProcess,
  stream: Duplex,
  failure: (error: Error) => void,
): void {
  let connected = true
  let failed = false
  const disconnect = () => {
    if (!connected) return
    connected = false
    child.emit("disconnect")
  }
  const abort = (error: Error) => {
    if (failed) return
    failed = true
    connected = false
    stream.destroy()
    failure(error)
  }
  const decoder = new BoundedJsonLines(value => child.emit("message", value), abort)
  Object.defineProperty(child, "connected", { configurable: true, get: () => connected })
  child.send = (message: unknown, ...extra: unknown[]) => {
    const callback = extra.find(value => typeof value === "function") as
      ((error: Error | null) => void) | undefined
    try {
      if (extra.length > 1 || (extra[0] !== undefined && typeof extra[0] !== "function"))
        throw new Error(M.nativeSandbox.handleTransfer)
      if (!connected || !stream.writable) throw new Error(M.nativeSandbox.ipcGone)
      if (
        message &&
        typeof message === "object" &&
        typeof (message as { cmd?: unknown }).cmd === "string" &&
        (message as { cmd: string }).cmd.startsWith("NODE_")
      )
        throw new Error(M.nativeSandbox.internalOutbound)
      const encoded = JSON.stringify(message)
      if (encoded === undefined || Buffer.byteLength(encoded) > maxTransportFrameBytes)
        throw new Error(M.nativeSandbox.outboundFrame)
      if (stream.writableLength > 16 * maxTransportFrameBytes)
        throw new Error(M.nativeSandbox.outboundQueue)
      return stream.write(`${encoded}\n`, error => callback?.(error ?? null))
    } catch (error) {
      const value = error instanceof Error ? error : new Error(M.nativeSandbox.outboundInvalid)
      callback?.(value)
      abort(value)
      return false
    }
  }
  child.disconnect = () => stream.destroy()
  stream.on("data", (chunk: Buffer) => decoder.write(chunk))
  stream.once("end", () => {
    decoder.end()
    disconnect()
  })
  stream.once("close", disconnect)
  stream.on("error", abort)
}
