import { AsyncLocalStorage } from "node:async_hooks"
import {
  botEventFail,
  botEventHandle,
  botEventName,
  botEventSessionId,
  nativeBotEventLimits,
  parseBotEventArguments,
  parseBotEventFrame,
  parseBotEventHandle,
  type NativeBotEventFrame,
  type NativeBotEventValue,
} from "./protocol.js"
import { M } from "../../shared/messages.js"

type Callback = (...args: unknown[]) => unknown
interface Subscription {
  event: string
  callback: Callback
  once: boolean
}
export interface NativeBotEventsGuestOptions {
  /** 宿主在本原生会话认证引导中签发的令牌。 */
  sessionId: string
  /** 构建插件本地回复代理，此处不得传入宿主函数。 */
  restoreArgs?(args: NativeBotEventValue[]): unknown[] | Promise<unknown[]>
}

/** 原回调对象始终留在受限插件进程。 */
export class NativeBotEventsGuest {
  readonly sessionId: string
  private readonly subscriptions = new Map<string, Subscription>()
  private sequence = 0
  private receiver: unknown
  private closed = false
  private failed = false
  private readonly deliveredExit = new Set<string>()
  private readonly inFlightExit = new Map<string, Promise<void>>()
  private readonly exitContext = new AsyncLocalStorage<boolean>()
  private exitDispatch?: Promise<void>

  /** 创建沙箱内的 Bot 事件监听代理。 */
  constructor(
    private readonly send: (frame: NativeBotEventFrame) => void,
    private readonly options: NativeBotEventsGuestOptions,
  ) {
    this.sessionId = botEventSessionId(options.sessionId)
  }

  /** 当前监听数量。 */
  get size(): number {
    return this.subscriptions.size
  }

  /** 绑定监听回调中的 this。 */
  bindThis(botFacade: object): this {
    this.active()
    this.receiver = botFacade
    return this
  }

  /** 确认代理未被释放。 */
  private active(): void {
    if (this.closed || this.failed) botEventFail("BOT_EVENT_CLOSED", "Bot event guest is closed")
  }
  /** 分配下一个监听序号。 */
  private next(): number {
    if (this.sequence === Number.MAX_SAFE_INTEGER)
      botEventFail("BOT_EVENT_SEQUENCE_LIMIT", "Bot event sequence exhausted")
    return ++this.sequence
  }
  /** 向宿主发布监听变化。 */
  private publish(frame: NativeBotEventFrame): void {
    try {
      this.send(parseBotEventFrame(frame))
    } catch (error) {
      this.failed = true
      throw error
    }
  }

  /** 添加监听。 */
  on(event: unknown, callback: unknown, once = false): this {
    this.active()
    const name = botEventName(event)
    if (typeof callback !== "function" || typeof once !== "boolean")
      return botEventFail("BOT_EVENT_INVALID_CALLBACK", "Bot listeners require a guest function")
    if (this.subscriptions.size >= nativeBotEventLimits.sessionListeners)
      return botEventFail("BOT_EVENT_SESSION_LIMIT", "Too many Bot listeners in one session")
    const sequence = this.next(),
      id = botEventHandle(this.sessionId, sequence)
    this.subscriptions.set(id, { event: name, callback: callback as Callback, once })
    this.publish({ type: "subscribe", sessionId: this.sessionId, sequence, id, event: name, once })
    return this
  }
  /** 添加一次性监听。 */
  once(event: unknown, callback: unknown): this {
    return this.on(event, callback, true)
  }

  /** 移除监听。 */
  off(event: unknown, callback: unknown): this {
    this.active()
    const name = botEventName(event)
    if (typeof callback !== "function")
      return botEventFail("BOT_EVENT_INVALID_CALLBACK", "Bot listeners require a guest function")
    // EventEmitter 移除最近注册的匹配回调，包括 once。
    const match = [...this.subscriptions]
      .reverse()
      .find(([, value]) => value.event === name && value.callback === callback)
    if (!match) return this
    this.subscriptions.delete(match[0])
    this.publish({
      type: "unsubscribe",
      sessionId: this.sessionId,
      sequence: this.next(),
      id: match[0],
    })
    return this
  }
  /** 移除监听（off 的别名）。 */
  removeListener(event: unknown, callback: unknown): this {
    return this.off(event, callback)
  }

  /** 移除事件或全部事件的监听。 */
  clear(event?: unknown): this {
    this.active()
    const name = event === undefined ? undefined : botEventName(event)
    for (const [id, value] of this.subscriptions)
      if (name === undefined || value.event === name) this.subscriptions.delete(id)
    this.publish({
      type: "clear",
      sessionId: this.sessionId,
      sequence: this.next(),
      ...(name === undefined ? {} : { event: name }),
    })
    return this
  }
  /** 移除全部监听（clear 的别名）。 */
  removeAllListeners(event?: unknown): this {
    return this.clear(event)
  }

  /** 执行宿主转来的事件回调。 */
  async dispatch(id: unknown, input: unknown): Promise<void> {
    this.active()
    const handle = parseBotEventHandle(id, this.sessionId),
      owned = this.subscriptions.get(handle)
    // 宿主退出与本地回收可能在 IPC 中交错，每个退出监听器仍最多执行一次。
    if (this.deliveredExit.has(handle)) {
      await this.inFlightExit.get(handle)
      return
    }
    if (!owned)
      return botEventFail("BOT_EVENT_UNKNOWN_HANDLE", "Bot listener is unknown or revoked")
    const args = parseBotEventArguments(input)
    if (owned.event === "exit") this.deliveredExit.add(handle)
    // 在任何 await 或回调重入前先移除，防止 once 投递重放。
    if (owned.once) this.subscriptions.delete(handle)
    const invocation = Promise.resolve().then(async () => {
      const restored = await (this.options.restoreArgs ? this.options.restoreArgs(args) : args)
      this.active()
      // EventEmitter 仅观察完成状态，回调返回的 SDK 或对象留在此处。
      if (owned.event === "exit")
        await this.exitContext.run(true, () =>
          Reflect.apply(owned.callback, this.receiver, restored),
        )
      else await Reflect.apply(owned.callback, this.receiver, restored)
    })
    if (owned.event === "exit") this.inFlightExit.set(handle, invocation)
    try {
      await invocation
    } finally {
      this.inFlightExit.delete(handle)
    }
  }

  /** 原生清理器在 close 前调用此方法，不向宿主发送合成事件。 */
  dispatchExit(input: unknown = []): Promise<void> {
    // 退出回调不能等待包含自身的清理过程；外层清理仍等待该回调。
    if (this.exitContext.getStore() === true) return Promise.resolve()
    if (this.exitDispatch) return this.exitDispatch
    this.active()
    const args = parseBotEventArguments(input)
    const ids = [...this.subscriptions]
      .filter(([id, owned]) => owned.event === "exit" && !this.deliveredExit.has(id))
      .map(([id]) => id)
    // once 回调虽已不在订阅表中，仍可能持有待完成的清理任务。
    const inFlight = [...this.inFlightExit.values()]
    this.exitDispatch = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        ...inFlight,
        ...ids.map(id => this.dispatch(id, args)),
      ])
      const errors = results
        .filter(result => result.status === "rejected")
        .map(result => result.reason)
      if (errors.length) throw new AggregateError(errors, M.nativeSandbox.botExitListeners)
    })
    return this.exitDispatch
  }

  /** 以宿主关闭为准；此帧仅尽力通知插件正常关闭。 */
  close(): void {
    if (this.closed) return
    try {
      this.publish({ type: "clear", sessionId: this.sessionId, sequence: this.next() })
    } finally {
      this.closed = true
      this.subscriptions.clear()
      this.deliveredExit.clear()
      this.inFlightExit.clear()
    }
  }
}
