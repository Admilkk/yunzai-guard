import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { nativeIdentityLimits, NativeIdentityError } from "./protocol.js"
import type { NativeIdentityOptions, RefusalCode, NativeFailureResult } from "./protocol.js"
import { resolveBundle } from "./bundle.js"
import {
  fail,
  object,
  keys,
  remaining,
  refusalCodes,
  parseNativeIdentityJson,
} from "./validation.js"
import type { ObjectValue } from "./validation.js"

export class Transport {
  readonly nonce = randomBytes(24).toString("hex")
  private readonly child: ChildProcess
  private buffer = Buffer.alloc(0)
  private stderrBytes = 0
  private sequence = 0
  private broken?: NativeIdentityError
  private pending?: {
    id: number
    command: string
    resolve(value: ObjectValue): void
    reject(error: Error): void
    timer: NodeJS.Timeout
  }
  private tail: Promise<unknown> = Promise.resolve()
  private normalClosing = false
  private closePromise?: Promise<void>
  private exited = false
  private exitCode: number | null = null
  private exitSignal: NodeJS.Signals | null = null
  private readonly exitPromise: Promise<void>
  private readonly failureWaiters = new Set<(error: NativeIdentityError) => void>()
  /** 启动原生身份辅助程序并建立请求通道。 */
  constructor(
    options: NativeIdentityOptions,
    readonly deadline: number,
  ) {
    let resolved: { root: string; executable: string }
    try {
      resolved = resolveBundle(options)
    } catch (error) {
      if (error instanceof NativeIdentityError) throw error
      throw new NativeIdentityError("NATIVE_PRIMITIVE_UNAVAILABLE", "refused-before-action")
    }
    remaining(deadline)
    this.child = spawn(resolved.executable, [], {
      cwd: resolved.root,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.exitPromise = new Promise(resolve =>
      this.child.once("exit", (code, signal) => {
        this.exited = true
        this.exitCode = code
        this.exitSignal = signal
        if (!this.normalClosing) this.break(new NativeIdentityError("NATIVE_OPERATION_UNKNOWN"))
        resolve()
      }),
    )
    this.child.once("error", () =>
      this.break(new NativeIdentityError("NATIVE_PRIMITIVE_UNAVAILABLE")),
    )
    this.child.stdin!.on("error", () =>
      this.break(new NativeIdentityError("NATIVE_OPERATION_UNKNOWN")),
    )
    this.child.stdout!.on("error", () =>
      this.break(new NativeIdentityError("NATIVE_OPERATION_UNKNOWN")),
    )
    this.child.stderr!.on("error", () =>
      this.break(new NativeIdentityError("NATIVE_OPERATION_UNKNOWN")),
    )
    this.child.stdout!.on("data", (chunk: Buffer) => {
      try {
        this.buffer = Buffer.concat([this.buffer, chunk])
        while (true) {
          const end = this.buffer.indexOf(10)
          if (end < 0) break
          if (end + 1 > nativeIdentityLimits.frameBytes) fail("FRAME_OR_SCOPE_LIMIT")
          const bytes = this.buffer.subarray(0, end)
          this.buffer = this.buffer.subarray(end + 1)
          const item = object(
            parseNativeIdentityJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
          )
          const pending = this.pending
          if (
            !pending ||
            item.protocol !== 1 ||
            item.sessionNonce !== this.nonce ||
            item.requestId !== pending.id
          )
            fail()
          if (item.type === "refused") {
            keys(
              item,
              ["protocol", "sessionNonce", "requestId", "type", "result", "code"],
              ["systemCode"],
            )
            if (
              !refusalCodes.has(item.code as RefusalCode) ||
              !["refused-before-action", "failed", "started-unconfirmed", "unknown"].includes(
                String(item.result),
              ) ||
              (item.systemCode !== undefined && !Number.isSafeInteger(item.systemCode))
            )
              fail()
            clearTimeout(pending.timer)
            this.pending = undefined
            pending.reject(
              new NativeIdentityError(
                item.code as RefusalCode,
                item.result as NativeFailureResult,
                item.systemCode as number | undefined,
              ),
            )
          } else {
            clearTimeout(pending.timer)
            this.pending = undefined
            pending.resolve(item)
          }
        }
        if (this.buffer.length >= nativeIdentityLimits.frameBytes) fail("FRAME_OR_SCOPE_LIMIT")
      } catch {
        this.break(new NativeIdentityError("STATE_OR_REQUEST_INVALID"))
      }
    })
    this.child.stderr!.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length
      if (this.stderrBytes > nativeIdentityLimits.stderrBytes)
        this.break(new NativeIdentityError("FRAME_OR_SCOPE_LIMIT"))
    })
    this.child.stdout!.once("end", () => {
      if (!this.normalClosing || this.pending)
        this.break(new NativeIdentityError("NATIVE_OPERATION_UNKNOWN"))
    })
  }
  /** 标记通道损坏并拒绝后续请求。 */
  private break(error: NativeIdentityError): void {
    if (this.broken) return
    this.broken = error
    const pending = this.pending
    this.pending = undefined
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(
        pending.command === "activate-inspector-once"
          ? new NativeIdentityError(error.code, "started-unconfirmed")
          : error,
      )
    }
    for (const reject of this.failureWaiters) reject(error)
    this.failureWaiters.clear()
    // EOF 会释放原生会话。Linux ChildProcess.kill 使用数字 PID，
    // 因此传输失败时不得回退到该方法，即使目标是自己的辅助进程。
    this.child.stdin?.destroy()
    this.child.stdout?.destroy()
    this.child.stderr?.destroy()
    if (!this.exited) this.child.unref()
  }
  /** 发送命令并等待匹配的回复。 */
  request(command: string, extra: ObjectValue = {}): Promise<ObjectValue> {
    const invoke = async (): Promise<ObjectValue> => {
      if (this.broken) throw this.broken
      const budget = remaining(this.deadline)
      if (++this.sequence > nativeIdentityLimits.requests) fail("FRAME_OR_SCOPE_LIMIT")
      const frame = {
        protocol: 1,
        sessionNonce: this.nonce,
        requestId: this.sequence,
        remainingBudgetMs: budget,
        command,
        ...extra,
      }
      const bytes = Buffer.from(`${JSON.stringify(frame)}\n`)
      if (bytes.length > nativeIdentityLimits.frameBytes) fail("FRAME_OR_SCOPE_LIMIT")
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.break(new NativeIdentityError("DEADLINE")), budget)
        this.pending = { id: this.sequence, command, resolve, reject, timer }
        this.child.stdin!.write(bytes, error => {
          if (error) this.break(new NativeIdentityError("NATIVE_OPERATION_UNKNOWN"))
        })
      })
    }
    const result = this.tail.then(invoke)
    this.tail = result.catch(() => {})
    return result
  }
  /** 校验回复的类型与字段。 */
  assertReply(item: ObjectValue, type: string, required: string[], optional: string[] = []): void {
    try {
      keys(item, ["protocol", "sessionNonce", "requestId", "type", ...required], optional)
      if (item.type !== type) fail()
    } catch (error) {
      this.break(new NativeIdentityError("STATE_OR_REQUEST_INVALID"))
      throw error
    }
  }
  /** 以状态无效原因断开通道。 */
  invalidate(): void {
    this.break(new NativeIdentityError("STATE_OR_REQUEST_INVALID"))
  }
  /** 执行校验，失败时断开通道并抛出。 */
  validate<T>(check: () => T): T {
    try {
      return check()
    } catch (error) {
      this.invalidate()
      throw error
    }
  }
  /** 关闭通道，重复调用返回同一个 Promise。 */
  close(): Promise<void> {
    return (this.closePromise ??= this.closeOnce())
  }
  /** 执行实际关闭并等待辅助程序退出。 */
  private async closeOnce(): Promise<void> {
    if (this.broken) {
      this.child.stdin?.end()
      throw this.broken
    }
    if (this.normalClosing) return
    this.normalClosing = true
    try {
      const reply = await this.request("close-session")
      this.assertReply(reply, "session-closed", ["released"])
      if (reply.released !== true) fail()
      this.child.stdin?.end()
      let rejectFailure: (error: NativeIdentityError) => void = () => {}
      const failed = new Promise<never>((_, reject) => {
        rejectFailure = reject
        this.failureWaiters.add(reject)
      })
      const timer = setTimeout(
        () => this.break(new NativeIdentityError("DEADLINE")),
        remaining(this.deadline),
      )
      try {
        await Promise.race([this.exitPromise, failed])
        if (this.broken) throw this.broken
        if (this.exitCode !== 0 || this.exitSignal !== null) fail("NATIVE_OPERATION_UNKNOWN")
      } finally {
        clearTimeout(timer)
        this.failureWaiters.delete(rejectFailure)
      }
    } catch (error) {
      this.break(
        error instanceof NativeIdentityError
          ? error
          : new NativeIdentityError("NATIVE_OPERATION_UNKNOWN"),
      )
      throw error
    }
  }
}
