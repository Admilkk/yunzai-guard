import type { GuardEvent } from "../shared/types.js"
import { mapDelete, mapEach, mapGet, mapSet, mapSize, newMap } from "../protect/intrinsics.js"

// 在任何业务代码运行前固定计时函数，插件之后替换全局函数不影响合并节奏。
const schedule = setTimeout
const cancel = clearTimeout
const clock = Date.now

interface Entry {
  event: GuardEvent
  repeated: number
  lastAt: number
}

export interface CoalesceOptions {
  /** 合并窗口；0 表示不合并。 */
  windowMs: () => number
  /** 同时跟踪的不同事件上限，超过后不再合并新事件，避免内存随目标数增长。 */
  maxKeys: number
  /** 交给审计队列，返回是否被接收。 */
  forward: (event: GuardEvent, critical: boolean) => boolean
}

/**
 * 业务进程侧的事件合并：窗口内完全相同的普通记录只发第一条，其余计数后以一条
 * “重复 N 次”汇总补发；队列已满被拒的记录按插件与类型累计，之后补一条溢出说明。
 * 拒绝、重启等关键事件始终逐条发送。
 */
export class EventCoalescer {
  readonly #options: CoalesceOptions
  readonly #entries = newMap<string, Entry>()
  readonly #dropped = newMap<string, { plugin: string; kind: string; count: number }>()
  #timer: ReturnType<typeof setTimeout> | undefined

  /** 创建合并器。 */
  constructor(options: CoalesceOptions) {
    this.#options = options
  }

  /** 提交一条事件。 */
  offer(event: GuardEvent, critical: boolean): void {
    const window = this.#options.windowMs()
    if (critical || window <= 0 || event.action === "deny" || event.action === "restart") {
      this.#send(event, critical)
      return
    }
    const key = `${event.plugin ?? ""}\0${event.kind}\0${event.operation}\0${event.target}`
    const entry = mapGet(this.#entries, key)
    if (entry) {
      entry.repeated++
      entry.lastAt = clock()
      this.#arm(window)
      return
    }
    if (mapSize(this.#entries) < this.#options.maxKeys)
      mapSet(this.#entries, key, { event, repeated: 0, lastAt: clock() })
    this.#send(event, false)
    this.#arm(window)
  }

  /** 交给审计队列；普通记录被拒时计入溢出统计。 */
  #send(event: GuardEvent, critical: boolean): boolean {
    if (this.#options.forward(event, critical) || critical) return true
    const key = `${event.plugin ?? "unknown"}\0${event.kind}`
    const dropped = mapGet(this.#dropped, key)
    if (dropped) dropped.count++
    else if (mapSize(this.#dropped) < 1024)
      mapSet(this.#dropped, key, { plugin: event.plugin ?? "unknown", kind: event.kind, count: 1 })
    return false
  }

  /** 排定下一次结算。 */
  #arm(window: number): void {
    if (this.#timer !== undefined) return
    this.#timer = schedule(() => {
      this.#timer = undefined
      this.flush()
    }, window)
    ;(this.#timer as { unref?: () => void }).unref?.()
  }

  /** 补发重复计数与溢出说明，清理已安静的条目。 */
  flush(): void {
    const now = clock()
    const window = this.#options.windowMs()
    const stale: string[] = []
    mapEach(this.#entries, (entry, key) => {
      if (entry.repeated > 0) {
        const sent = this.#send(
          {
            ...entry.event,
            timestamp: new Date(now).toISOString(),
            details: { ...entry.event.details, repeated: entry.repeated, windowMs: window },
          },
          false,
        )
        if (sent) entry.repeated = 0
      } else if (now - entry.lastAt >= window) stale.push(key)
    })
    for (const key of stale) mapDelete(this.#entries, key)
    const overflow: Array<{ plugin: string; kind: string; count: number }> = []
    mapEach(this.#dropped, value => overflow.push(value))
    for (const item of overflow) {
      const accepted = this.#options.forward(
        {
          kind: "coverage",
          operation: "audit-overflow",
          target: `${item.plugin}/${item.kind}`,
          plugin: item.plugin,
          action: "audit",
          timestamp: new Date(now).toISOString(),
          details: { dropped: item.count, kind: item.kind },
        },
        false,
      )
      if (accepted) mapDelete(this.#dropped, `${item.plugin}\0${item.kind}`)
    }
    if (mapSize(this.#entries) || mapSize(this.#dropped)) this.#arm(window || 1000)
  }

  /** 停止计时并立即结算，供业务进程退出前调用。 */
  close(): void {
    if (this.#timer !== undefined) cancel(this.#timer)
    this.#timer = undefined
    this.flush()
    if (this.#timer !== undefined) cancel(this.#timer)
    this.#timer = undefined
  }
}
