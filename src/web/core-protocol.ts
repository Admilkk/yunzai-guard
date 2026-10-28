import { receiveMessageOnPort, type MessagePort } from "node:worker_threads"

/**
 * 宿主与控制台线程之间的调用协议。
 * 控制台代码按同步接口调用宿主（读取状态、提交配置等），线程端以 Atomics 等待宿主回复；
 * 耗时操作（检查更新、测试 Webhook、扫描来源）走异步通道，不阻塞线程。
 */
export const coreProtocolVersion = 1

export interface CoreCall {
  id: number
  method: string
  args: unknown[]
}

export type CoreReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { message: string; status?: number } }

/** 线程启动参数。 */
export interface CoreThreadData {
  protocol: number
  root: string
  stateDir: string
  settings: unknown
  syncPort: MessagePort
  asyncPort: MessagePort
  /** 同步调用的唤醒标志：Int32Array 视图，宿主回复后置 1。 */
  signal: SharedArrayBuffer
  /** 上一个线程交来的内存会话。 */
  handover?: unknown
}

/** 宿主发给线程的控制消息。 */
export type CoreCommand = { type: "stop" } | { type: "login-link"; id: number }

/** 线程发给宿主的状态消息。 */
export type CoreEvent =
  | { type: "ready"; listening: boolean; version: string }
  | { type: "stopped"; handover?: unknown }
  | { type: "login-link-result"; reply: CoreReply }

/** 宿主处理调用超过此时间时，同步调用视为失败，避免线程永久阻塞。 */
const syncTimeoutMs = 15_000

/** 把异常转成可跨线程传递的错误描述。 */
export function serializeError(error: unknown): { message: string; status?: number } {
  const message = error instanceof Error ? error.message : String(error)
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === "number" ? { message, status } : { message }
}

/** 还原跨线程传来的错误，保留 HTTP 状态码。 */
export function restoreError(error: { message: string; status?: number }): Error {
  const result = new Error(error.message) as Error & { status?: number }
  if (error.status !== undefined) result.status = error.status
  return result
}

/** 线程端：创建同步调用函数。线程是单线程的，同一时刻最多一个同步调用在途。 */
export function syncCaller(port: MessagePort, signal: SharedArrayBuffer) {
  const flag = new Int32Array(signal)
  let sequence = 0
  return (method: string, ...args: unknown[]): unknown => {
    const id = ++sequence
    Atomics.store(flag, 0, 0)
    port.postMessage({ id, method, args } satisfies CoreCall)
    if (Atomics.wait(flag, 0, 0, syncTimeoutMs) === "timed-out")
      throw new Error(`宿主未在 ${syncTimeoutMs / 1000} 秒内响应：${method}`)
    // 超时后迟到的旧回复会排在前面，按编号丢弃。
    for (;;) {
      const received = receiveMessageOnPort(port)
      if (!received) throw new Error(`宿主回复缺失：${method}`)
      const reply = received.message as CoreReply
      if (reply.id !== id) continue
      if (reply.ok) return reply.value
      throw restoreError(reply.error)
    }
  }
}

/** 线程端：创建异步调用函数。 */
export function asyncCaller(port: MessagePort) {
  let sequence = 0
  const waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  port.on("message", (reply: CoreReply) => {
    const entry = waiting.get(reply.id)
    if (!entry) return
    waiting.delete(reply.id)
    if (reply.ok) entry.resolve(reply.value)
    else entry.reject(restoreError(reply.error))
  })
  port.unref()
  return (method: string, ...args: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      waiting.set(id, { resolve, reject })
      port.postMessage({ id, method, args } satisfies CoreCall)
    })
}

export type CoreHandlers = Record<string, (...args: unknown[]) => unknown>

/**
 * 宿主端：处理线程发来的调用。同步通道回复后置位并唤醒线程；
 * 处理函数返回 Promise 时同样等待完成再回复。
 */
export function serveCalls(
  port: MessagePort,
  handlers: CoreHandlers,
  signal?: SharedArrayBuffer,
): void {
  const flag = signal ? new Int32Array(signal) : undefined
  port.on("message", (call: CoreCall) => {
    const reply = (value: CoreReply): void => {
      try {
        port.postMessage(value)
      } catch (error) {
        port.postMessage({ id: value.id, ok: false, error: serializeError(error) })
      }
      if (flag) {
        Atomics.store(flag, 0, 1)
        Atomics.notify(flag, 0)
      }
    }
    const handler = Object.hasOwn(handlers, call?.method) ? handlers[call.method] : undefined
    if (!handler) {
      reply({ id: call?.id, ok: false, error: { message: `未知调用：${String(call?.method)}` } })
      return
    }
    let result: unknown
    try {
      result = handler(...(Array.isArray(call.args) ? call.args : []))
    } catch (error) {
      reply({ id: call.id, ok: false, error: serializeError(error) })
      return
    }
    Promise.resolve(result).then(
      value => reply({ id: call.id, ok: true, value }),
      error => reply({ id: call.id, ok: false, error: serializeError(error) }),
    )
  })
}
