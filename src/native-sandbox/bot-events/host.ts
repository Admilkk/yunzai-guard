import { randomUUID } from "node:crypto"
import {
  botEventFail,
  botEventSessionId,
  nativeBotEventLimits,
  parseBotEventArguments,
  parseBotEventFrame,
  type NativeBotEventValue,
} from "./protocol.js"
import { M } from "../../shared/messages.js"

type Listener = (...args: unknown[]) => unknown
interface OwnedListener {
  id: string
  event: string
  once: boolean
  facade: Listener
  state: "pending" | "active" | "revoking" | "revoked" | "delivering"
}
const ownership = new WeakMap<object, Set<OwnedListener>>()

export interface NativeBotEventsEmitter {
  /** 实际底层 Bot 事件发射器，全部会话必须使用同一对象身份。 */
  key: object
  /** 可信且已绑定的方法，不能从插件输入解析方法。 */
  on(event: string, listener: Listener): unknown
  off(event: string, listener: Listener): unknown
  eventNames(): (string | symbol)[]
  listeners(event: string | symbol): Function[]
}
export interface NativeBotEventsFailure {
  kind: "delivery" | "cleanup"
  id: string
  event: string
  error: unknown
}
export interface NativeBotEventsHostOptions {
  emitter: NativeBotEventsEmitter
  sessionId?: string
  /** 执行当前 native.bot.on/事件名规则，返回 false 或抛错即拒绝注册。 */
  policy(event: string): boolean | void
  /** originalEvent 留在宿主，仅用于绑定请求能力和 ALS。 */
  invoke(
    id: string,
    args: NativeBotEventValue[],
    originalEvent?: Record<string, unknown>,
  ): Promise<unknown>
  serializeArgs?(args: unknown[], event: string): NativeBotEventValue[]
  /** 清理失败时，集成方必须终止并回收原生会话。 */
  onFailure(failure: NativeBotEventsFailure): void
}

export class NativeBotEventsCleanupError extends AggregateError {
  readonly code = "BOT_EVENT_CLEANUP_UNCONFIRMED"
}

/** 每个宿主闭包只属于一个会话，调用方不能选择其他会话或核心监听器。 */
export class NativeBotEventsHost {
  readonly sessionId: string
  private readonly subscriptions = new Map<string, OwnedListener>()
  private readonly allOwned: Set<OwnedListener>
  private sequence = 0
  private pendingDeliveries = 0
  private readonly pendingOnce = new Map<string, OwnedListener>()
  private readonly retiredOnce = new Map<string, string>()
  private closed = false
  private reporting = false

  /** 创建工作进程侧的 Bot 事件监听代理。 */
  constructor(private readonly options: NativeBotEventsHostOptions) {
    this.sessionId = botEventSessionId(options.sessionId ?? randomUUID())
    const emitter = options.emitter
    if (
      !emitter?.key ||
      typeof emitter.key !== "object" ||
      [
        emitter.on,
        emitter.off,
        emitter.eventNames,
        emitter.listeners,
        options.policy,
        options.invoke,
        options.onFailure,
      ].some(method => typeof method !== "function")
    )
      botEventFail("BOT_EVENT_INVALID_HOST", "Trusted Bot event interfaces are unavailable")
    this.allOwned = ownership.get(emitter.key) ?? new Set()
    ownership.set(emitter.key, this.allOwned)
  }

  /** 监听与投递统计。 */
  get stats(): Readonly<{
    listeners: number
    pendingDeliveries: number
    retiredOnce: number
    closed: boolean
  }> {
    return Object.freeze({
      listeners: this.subscriptions.size,
      pendingDeliveries: this.pendingDeliveries,
      retiredOnce: this.retiredOnce.size,
      closed: this.closed,
    })
  }
  /** 确认代理未被释放。 */
  private active(): void {
    if (this.closed) botEventFail("BOT_EVENT_CLOSED", "Bot event host is closed")
  }
  /** 上报监听投递失败。 */
  private report(kind: NativeBotEventsFailure["kind"], owned: OwnedListener, error: unknown): void {
    // 日志或失败处理不能通过可信核心发射器向外抛错。
    if (this.reporting) return
    this.reporting = true
    try {
      this.options.onFailure({ kind, id: owned.id, event: owned.event, error })
    } catch {
    } finally {
      this.reporting = false
    }
  }
  /** 返回核心上该事件的监听列表。 */
  private listeners(event: string | symbol): Function[] {
    const result = this.options.emitter.listeners(event)
    if (!Array.isArray(result) || result.some(listener => typeof listener !== "function"))
      return botEventFail("BOT_EVENT_INSPECTION_FAILED", "Cannot inspect trusted Bot listeners")
    return result
  }
  /** 统计本代理登记的监听总数。 */
  private totalListeners(): number {
    const names = this.options.emitter.eventNames()
    if (
      !Array.isArray(names) ||
      names.length > nativeBotEventLimits.emitterListeners ||
      names.some(name => typeof name !== "string" && typeof name !== "symbol")
    )
      return botEventFail("BOT_EVENT_EMITTER_LIMIT", "Bot emitter exceeds its listener bound")
    return (
      names.reduce((total, name) => total + this.listeners(name).length, 0) +
      [...this.allOwned].filter(owned => owned.state === "pending").length
    )
  }
  /** 从核心移除一个代理监听。 */
  private remove(owned: OwnedListener): void {
    if (owned.state === "pending")
      botEventFail(
        "BOT_EVENT_CLEANUP_UNCONFIRMED",
        "Bot listener registration is still in progress",
      )
    owned.state = "revoking"
    this.options.emitter.off(owned.event, owned.facade)
    if (this.listeners(owned.event).includes(owned.facade))
      botEventFail("BOT_EVENT_CLEANUP_UNCONFIRMED", "Owned Bot listener is still attached")
    this.subscriptions.delete(owned.id)
    this.allOwned.delete(owned)
    owned.state = "revoked"
  }
  /** 移除事件或全部代理监听。 */
  private clear(event?: string): void {
    const errors: unknown[] = []
    for (const owned of this.pendingOnce.values())
      if (event === undefined || owned.event === event) owned.state = "revoked"
    for (const [id, name] of this.retiredOnce)
      if (event === undefined || name === event) this.retiredOnce.delete(id)
    for (const owned of [...this.subscriptions.values()]) {
      if (event !== undefined && owned.event !== event) continue
      try {
        this.remove(owned)
      } catch (error) {
        errors.push(error)
        this.report("cleanup", owned, error)
      }
    }
    if (errors.length)
      throw new NativeBotEventsCleanupError(errors, M.nativeSandbox.botEventCleanup)
  }
  /** 把事件投递给沙箱中的监听。 */
  private deliver(owned: OwnedListener, args: unknown[]): Promise<void> | void {
    if (this.closed || owned.state !== "active") return
    try {
      // 自行包装 once，避免发射器的不透明包装；投递前先撤销。
      if (owned.once) {
        try {
          this.remove(owned)
          this.retiredOnce.set(owned.id, owned.event)
        } catch (error) {
          this.report("cleanup", owned, error)
          return
        }
      }
      if (this.pendingDeliveries >= nativeBotEventLimits.pendingDeliveries)
        return botEventFail("BOT_EVENT_DELIVERY_LIMIT", "Too many pending Bot event deliveries")
      const values = parseBotEventArguments(this.options.serializeArgs?.(args, owned.event) ?? args)
      const originalEvent =
        args[0] && typeof args[0] === "object" && !Array.isArray(args[0])
          ? (args[0] as Record<string, unknown>)
          : undefined
      if (owned.once) {
        owned.state = "delivering"
        this.pendingOnce.set(owned.id, owned)
      }
      this.pendingDeliveries++
      // exitEvent 等待 rawListeners；普通 emit 忽略已处理拒绝的 Promise。
      return Promise.resolve()
        .then(async () => {
          if (this.closed || owned.state !== (owned.once ? "delivering" : "active")) return
          await this.options.invoke(owned.id, values, originalEvent)
          this.retiredOnce.delete(owned.id)
        })
        .catch(error => this.report("delivery", owned, error))
        .finally(() => {
          this.pendingOnce.delete(owned.id)
          this.pendingDeliveries--
        })
    } catch (error) {
      this.report("delivery", owned, error)
    }
  }

  /** 仅分发当前实例原生会话的已认证帧。 */
  receive(input: unknown): void {
    this.active()
    const frame = parseBotEventFrame(input)
    if (frame.sessionId !== this.sessionId)
      return botEventFail("BOT_EVENT_FOREIGN_SESSION", "Bot event frame belongs to another session")
    if (frame.sequence !== this.sequence + 1)
      return botEventFail("BOT_EVENT_REPLAY", "Bot event frame was replayed or reordered")
    this.sequence = frame.sequence
    if (frame.type === "clear") {
      this.clear(frame.event)
      return
    }
    if (frame.type === "unsubscribe") {
      const owned = this.subscriptions.get(frame.id)
      if (!owned) {
        // 插件同步移除回调时，once 事件可能已排队。
        const queued = this.pendingOnce.get(frame.id)
        if (!this.retiredOnce.has(frame.id))
          return botEventFail("BOT_EVENT_UNKNOWN_HANDLE", "Bot listener is unknown or revoked")
        if (queued) queued.state = "revoked"
        this.retiredOnce.delete(frame.id)
        return
      }
      try {
        this.remove(owned)
      } catch (error) {
        this.report("cleanup", owned, error)
        throw error
      }
      return
    }
    if (this.options.policy(frame.event) === false)
      return botEventFail("BOT_EVENT_POLICY_DENIED", "Bot event subscription is denied by policy")
    if (this.subscriptions.size >= nativeBotEventLimits.sessionListeners)
      return botEventFail("BOT_EVENT_SESSION_LIMIT", "Too many Bot listeners in one session")
    // 注册时预留撤销槽位，避免驱逐待完成或失败的 once 句柄。
    if (
      frame.once &&
      this.retiredOnce.size + [...this.subscriptions.values()].filter(owned => owned.once).length >=
        nativeBotEventLimits.retiredOnce
    )
      return botEventFail(
        "BOT_EVENT_RETIREMENT_LIMIT",
        "Retired Bot once listeners require off or clear before another subscription",
      )
    if (this.totalListeners() >= nativeBotEventLimits.emitterListeners)
      return botEventFail("BOT_EVENT_EMITTER_LIMIT", "Too many listeners on the Bot emitter")
    const owned: OwnedListener = {
      id: frame.id,
      event: frame.event,
      once: frame.once,
      state: "pending",
      facade: (...args) => this.deliver(owned, args),
    }
    this.subscriptions.set(owned.id, owned)
    this.allOwned.add(owned)
    try {
      this.options.emitter.on(owned.event, owned.facade)
      owned.state = "active"
      this.active()
      if (this.listeners(owned.event).filter(listener => listener === owned.facade).length !== 1)
        botEventFail(
          "BOT_EVENT_REGISTRATION_UNCONFIRMED",
          "Owned Bot listener was not attached exactly once",
        )
    } catch (error) {
      owned.state = "revoking"
      try {
        this.remove(owned)
      } catch (cleanupError) {
        this.report("cleanup", owned, cleanupError)
        throw new NativeBotEventsCleanupError(
          [error, cleanupError],
          M.nativeSandbox.botEventRollback,
        )
      }
      throw error
    }
  }

  /** 失败条目保留在双方账本中，供重试和强制回收报告使用。 */
  close(): void {
    this.closed = true
    this.clear()
  }
}
