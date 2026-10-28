import type { Writable } from "node:stream"
import { performance } from "node:perf_hooks"
import { addCounter, type TransportCounters } from "./diagnostics.js"
import { M } from "../../shared/messages.js"

/** 生命周期回调保留原进程句柄的所有权。 */
export interface DisposeOptions {
  stop(): void
  hasExited(): boolean
  kill(): void
  exited: Promise<void>
  cleanup: Promise<void>
  timeout: number
}

/** 回调成功仅证明原生 stdin 写入完成，不证明审计追加完成。 */
export function writeControl(
  stream: Pick<Writable, "writable" | "destroyed" | "writableLength" | "write"> | null,
  connected: boolean,
  message: unknown,
  counters: TransportCounters["control"],
  callback?: (error: Error | null) => void,
): boolean {
  counters.offered = addCounter(counters.offered)
  const reject = (error: Error): false => {
    counters.rejected = addCounter(counters.rejected)
    if (callback) callback(error)
    else throw error
    return false
  }
  if (!connected || !stream?.writable || stream.destroyed) {
    counters.closed = addCounter(counters.closed)
    return reject(new Error(M.sandbox.brokerGone))
  }
  let text: string
  try {
    text = `${JSON.stringify(message)}\n`
  } catch (error) {
    return reject(error instanceof Error ? error : new Error(String(error)))
  }
  const bytes = Buffer.byteLength(text)
  if (bytes > 65536) return reject(new Error(M.sandbox.ipcFrame))
  if (stream.writableLength + bytes > 256 * 1024) return reject(new Error(M.sandbox.ipcQueue))
  counters.accepted = addCounter(counters.accepted)
  let settled = false
  const complete = (error?: Error | null) => {
    if (settled) return
    settled = true
    if (error) counters.unknown = addCounter(counters.unknown)
    else counters.completed = addCounter(counters.completed)
    callback?.(error ?? null)
  }
  try {
    return stream.write(text, complete)
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    complete(failure)
    if (!callback) throw failure
    return false
  }
}

/** 用户输出流无法继续接收时，仍持续排空原生 stdout。 */
export function forwardOutput(
  stream: Pick<Writable, "writable" | "destroyed" | "writableLength" | "write">,
  bytes: Buffer,
  counters: TransportCounters["output"],
): boolean {
  counters.offeredBytes = addCounter(counters.offeredBytes, bytes.length)
  if (!stream.writable || stream.destroyed || stream.writableLength + bytes.length > 256 * 1024) {
    counters.droppedBytes = addCounter(counters.droppedBytes, bytes.length)
    return false
  }
  try {
    const accepted = stream.write(bytes, error => {
      if (error) counters.unknownBytes = addCounter(counters.unknownBytes, bytes.length)
    })
    counters.forwardedBytes = addCounter(counters.forwardedBytes, bytes.length)
    return accepted
  } catch {
    counters.unknownBytes = addCounter(counters.unknownBytes, bytes.length)
    return false
  }
}

/** stop 写入失败也必须清理原 ChildProcess 句柄。 */
export async function disposeProcess(options: DisposeOptions): Promise<void> {
  const errors: unknown[] = []
  const expiresAt = performance.now() + options.timeout
  const settled = Promise.allSettled([options.exited, options.cleanup])
  const wait = async (budget: number) => {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        settled,
        new Promise<null>(resolve => {
          timer = setTimeout(() => resolve(null), Math.max(0, budget))
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  if (!options.hasExited()) {
    try {
      options.stop()
    } catch (error) {
      errors.push(error)
    }
  }
  const kill = () => {
    // ChildProcess 对象持有原进程句柄，不按数字 PID 重新打开。
    if (!options.hasExited()) {
      try {
        options.kill()
      } catch (error) {
        errors.push(error)
      }
    }
  }
  if (errors.length) kill()
  let result = await wait(
    Math.max(0, expiresAt - performance.now() - Math.min(5000, options.timeout / 4)),
  )
  if (!result) {
    errors.push(new Error(M.sandbox.brokerExitBudget))
    kill()
    result = await wait(expiresAt - performance.now())
  }
  if (!result) errors.push(new Error(M.sandbox.brokerExit))
  else for (const item of result) if (item.status === "rejected") errors.push(item.reason)
  if (errors.length) throw new AggregateError(errors, M.sandbox.dispose)
}
