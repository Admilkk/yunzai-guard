import { performance } from "node:perf_hooks"
import {
  auditFrameBytes,
  auditLossCounts,
  auditOrdinaryBytes,
  auditOrdinaryRecords,
  copyAuditData,
  type AuditDeadline,
  type AuditLossReason,
  type AuditFlushOutcome,
} from "./protocol.js"
import type { AuditAppendReceipt, AuditSink, AuditSinkFrame } from "./sink.js"
import { M } from "../shared/messages.js"

export type AuditBufferSettlement =
  | AuditAppendReceipt
  | { result: "rejected"; reason: "critical-coalesced" }
  | { result: "unknown"; reason: "sink-error"; sequence?: number }
export type AuditBufferOffer =
  | { accepted: true; admissionSerial: number }
  | { accepted: false; reason: AuditLossReason | "critical-coalesced" }
export interface AuditBufferOptions {
  sink: Pick<AuditSink, "appendBatch">
  maxEventsPerSecond: number
  maxBytes: number
  now?: () => number
  setTimer?: (callback: () => void, delay: number) => unknown
  clearTimer?: (timer: unknown) => void
}
export type AuditBufferLimits = Pick<AuditBufferOptions, "maxEventsPerSecond" | "maxBytes">

/** 校验速率与字节上限是否为合法正数。 */
function checkLimits(limits: AuditBufferLimits): AuditBufferLimits {
  if (
    !Number.isFinite(limits.maxEventsPerSecond) ||
    limits.maxEventsPerSecond < 1 ||
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes < 1
  )
    throw new TypeError(M.audit.bufferLimits)
  return { maxEventsPerSecond: limits.maxEventsPerSecond, maxBytes: limits.maxBytes }
}
interface Entry {
  frame: AuditSinkFrame
  bytes: number
  admission: number
  critical: boolean
  inFlight: boolean
  settled: boolean
  onSettled?: (receipt: AuditBufferSettlement) => void
}
const permitBrand = Symbol("audit-close-permit")
export interface AuditClosePermit {
  readonly [permitBrand]: true
  readonly generation: number
  readonly nonce: string
  readonly acceleratedCutoff: number
  readonly deadline: AuditDeadline
}
export interface AuditBufferFlushResult {
  outcome: AuditFlushOutcome
  cutoff: number
  pendingRecords: number
  pendingBytes: number
  written: number
  dropped: number
  unknown: number
  accelerated: boolean
  deadlineExceeded: boolean
}

/** 仅接收已授权的不可变观察记录；策略决策必须先于 offer()。 */
export class AuditBuffer {
  readonly #options: AuditBufferOptions
  #limits: AuditBufferLimits
  readonly #normal: Entry[] = []
  readonly #inFlight = new Set<Entry>()
  readonly #rejected = auditLossCounts()
  readonly #permits = new WeakMap<object, { consumed: boolean }>()
  #currentPermit?: AuditClosePermit
  #critical?: Entry
  #bytes = 0
  #inFlightBytes = 0
  #inFlightOrdinary = 0
  #criticalInFlight = false
  #admission = 0
  #offered = 0
  #accepted = 0
  #written = 0
  #dropped = 0
  #unknown = 0
  #criticalCoalesced = 0
  #criticalWriteFailed = 0
  #settlementErrors = 0
  #highWaterRecords = 0
  #highWaterBytes = 0
  #tokens: number
  #last: number
  #timer?: unknown
  #closed = false
  #pumping = false
  #fast?: { cutoff: number; deadline: AuditDeadline }
  /** 创建审计缓冲区。 */
  constructor(options: AuditBufferOptions) {
    this.#limits = checkLimits(options)
    this.#options = options
    this.#tokens = options.maxEventsPerSecond
    this.#last = this.#now()
  }
  /** 运行时更新速率与容量上限，已有令牌按新上限截断。 */
  updateLimits(limits: AuditBufferLimits): void {
    const next = checkLimits(limits)
    this.#refill()
    this.#limits = next
    this.#tokens = Math.min(this.#tokens, next.maxEventsPerSecond)
    this.#cancel()
    this.#schedule()
  }
  /** 读取当前单调时间，可由测试注入。 */
  #now(): number {
    return this.#options.now?.() ?? performance.now()
  }
  /** 按经过时间补充速率令牌。 */
  #refill(): void {
    const current = this.#now()
    const elapsed = Math.max(0, current - this.#last)
    this.#last = Math.max(current, this.#last)
    this.#tokens = Math.min(
      this.#limits.maxEventsPerSecond,
      this.#tokens + (elapsed * this.#limits.maxEventsPerSecond) / 1000,
    )
  }
  /** 取消已排定的提交定时器。 */
  #cancel(): void {
    if (this.#timer === undefined) return
    if (this.#options.clearTimer) this.#options.clearTimer(this.#timer)
    else clearTimeout(this.#timer as NodeJS.Timeout)
    this.#timer = undefined
  }
  /** 在有待提交事件时排定下一次提交。 */
  #schedule(delay = 0): void {
    if (this.#timer !== undefined || (!this.#normal.length && !this.#critical)) return
    const callback = () => {
      this.#timer = undefined
      this.#pump()
    }
    if (this.#options.setTimer) this.#timer = this.#options.setTimer(callback, delay)
    else {
      const timer = setTimeout(callback, delay)
      timer.unref()
      this.#timer = timer
    }
  }
  /** 调用结算回调并吞掉回调异常。 */
  #notify(callback: Entry["onSettled"], receipt: AuditBufferSettlement): void {
    try {
      callback?.(receipt)
    } catch {
      this.#settlementErrors++
      this.#unknown++
    }
  }
  /** 提交一帧审计数据；关键事件优先且不受速率限制。 */
  offer(
    frame: AuditSinkFrame,
    options: {
      critical?: boolean
      onSettled?: (receipt: AuditBufferSettlement) => void
    } = {},
  ): AuditBufferOffer {
    this.#offered++
    const reject = (reason: AuditLossReason | "critical-coalesced"): AuditBufferOffer => {
      if (reason === "critical-coalesced") this.#criticalCoalesced++
      else this.#rejected[reason]++
      this.#dropped++
      this.#notify(options.onSettled, { result: "rejected", reason })
      return { accepted: false, reason }
    }
    if (this.#closed) return reject("after-seal")
    let copy: AuditSinkFrame
    let bytes: number
    try {
      const details = copyAuditData(frame.details ?? {}) as Record<string, unknown>
      if (!details || Array.isArray(details) || typeof frame.type !== "string")
        return reject("serialization")
      copy = { type: frame.type, details, time: frame.time ?? Date.now() }
      bytes =
        Buffer.byteLength(
          JSON.stringify({
            ...copy.details,
            type: copy.type,
            time: copy.time,
            hostPid: Number.MAX_SAFE_INTEGER,
            sequence: Number.MAX_SAFE_INTEGER,
          }),
        ) + 1
    } catch {
      return reject("serialization")
    }
    if (bytes > Math.min(auditFrameBytes, this.#limits.maxBytes)) return reject("oversize")
    // 关键槽位只有一个；被占用时改走普通队列，普通队列也满时才计为合并丢弃。
    const fallback = Boolean(options.critical && (this.#critical || this.#criticalInFlight))
    const critical = options.critical === true && !fallback
    if (!critical) {
      if (this.#normal.length + this.#inFlightOrdinary >= auditOrdinaryRecords)
        return reject(fallback ? "critical-coalesced" : "queue-records")
      if (
        this.#bytes + this.#inFlightBytes + bytes >
        Math.min(auditOrdinaryBytes, this.#limits.maxBytes)
      )
        return reject(fallback ? "critical-coalesced" : "queue-bytes")
    }
    const item: Entry = {
      frame: copy,
      bytes,
      admission: ++this.#admission,
      critical,
      settled: false,
      onSettled: options.onSettled,
      inFlight: false,
    }
    if (item.critical) this.#critical = item
    else {
      this.#normal.push(item)
      this.#bytes += bytes
    }
    this.#accepted++
    this.#highWaterRecords = Math.max(
      this.#highWaterRecords,
      this.#normal.length + this.#inFlightOrdinary,
    )
    this.#highWaterBytes = Math.max(this.#highWaterBytes, this.#bytes + this.#inFlightBytes)
    this.#schedule()
    return { accepted: true, admissionSerial: item.admission }
  }
  /** 结算单条事件并通知调用方，重复结算会被忽略。 */
  #settle(item: Entry, receipt: AuditBufferSettlement): void {
    if (item.settled) return
    item.settled = true
    if (item.inFlight) {
      this.#inFlight.delete(item)
      if (item.critical) this.#criticalInFlight = false
      else {
        this.#inFlightOrdinary--
        this.#inFlightBytes -= item.bytes
      }
    }
    if (receipt.result === "written") this.#written++
    else {
      this.#dropped++
      if (receipt.result === "unknown") this.#unknown++
      this.#rejected[receipt.reason as AuditLossReason]++
      if (item.critical) this.#criticalWriteFailed++
    }
    this.#notify(item.onSettled, receipt)
  }
  /** 按速率与字节预算把待提交事件写入落盘端。 */
  #pump(): void {
    if (this.#pumping) return
    this.#pumping = true
    try {
      this.#refill()
      const batch: Entry[] = []
      let bytes = 0
      if (this.#critical) {
        batch.push(this.#critical)
        bytes += this.#critical.bytes
        this.#criticalInFlight = true
        this.#critical = undefined
      }
      while (this.#normal.length && batch.length < 64) {
        const item = this.#normal[0]!
        const accelerated =
          this.#fast && item.admission <= this.#fast.cutoff && this.#fast.deadline.remainingMs() > 0
        if (!accelerated && this.#tokens < 1) break
        if (batch.length && bytes + item.bytes > auditFrameBytes) break
        this.#normal.shift()
        this.#bytes -= item.bytes
        if (!accelerated) this.#tokens--
        batch.push(item)
        bytes += item.bytes
      }
      if (batch.length) {
        for (const item of batch) {
          item.inFlight = true
          this.#inFlight.add(item)
          if (!item.critical) {
            this.#inFlightOrdinary++
            this.#inFlightBytes += item.bytes
          }
        }
        let receipts: readonly AuditBufferSettlement[]
        try {
          receipts = this.#options.sink.appendBatch(batch.map(item => item.frame))
        } catch {
          receipts = batch.map(() => ({ result: "unknown", reason: "sink-error" }))
        }
        for (let index = 0; index < batch.length; index++)
          this.#settle(
            batch[index]!,
            receipts[index] ?? { result: "unknown", reason: "sink-error" },
          )
      }
      if (this.#normal.length || this.#critical) {
        const accelerated =
          this.#fast &&
          this.#normal[0] &&
          this.#normal[0].admission <= this.#fast.cutoff &&
          this.#fast.deadline.remainingMs() > 0
        this.#schedule(
          this.#critical || accelerated || this.#tokens >= 1
            ? 0
            : Math.max(1, Math.ceil(((1 - this.#tokens) * 1000) / this.#limits.maxEventsPerSecond)),
        )
      }
    } finally {
      this.#pumping = false
    }
  }
  /** 为指定代次创建关闭许可，供 flush/close 使用。 */
  createClosePermit(options: {
    generation: number
    nonce: string
    deadline: AuditDeadline
  }): AuditClosePermit {
    if (
      !Number.isSafeInteger(options.generation) ||
      options.generation < 1 ||
      !/^[a-zA-Z0-9_-]{16,128}$/.test(options.nonce)
    )
      throw new TypeError(M.audit.closePermit)
    if (this.#currentPermit?.generation === options.generation) {
      if (this.#currentPermit.nonce !== options.nonce)
        throw new TypeError(M.audit.closeNonceChanged)
      return this.#currentPermit
    }
    if (this.#currentPermit && this.#currentPermit.generation > options.generation)
      throw new TypeError(M.audit.closeStale)
    const permit = Object.freeze({
      [permitBrand]: true as const,
      ...options,
      acceleratedCutoff: this.#admission,
    })
    this.#permits.set(permit, { consumed: false })
    this.#currentPermit = permit
    return permit
  }
  /** 统计截止序号前仍未结算的事件。 */
  #remaining(cutoff: number) {
    const rows = this.#normal.filter(item => item.admission <= cutoff)
    rows.push(...[...this.#inFlight].filter(item => item.admission <= cutoff))
    if (this.#critical && this.#critical.admission <= cutoff) rows.push(this.#critical)
    return { records: rows.length, bytes: rows.reduce((sum, item) => sum + item.bytes, 0) }
  }
  /** 在截止时间内尽量提交已接收的事件，并返回结算摘要。 */
  async flush(options: {
    deadline: AuditDeadline
    closePermit?: AuditClosePermit
  }): Promise<AuditBufferFlushResult> {
    let accelerated = false
    const permit = options.closePermit
    const cutoff = permit?.acceleratedCutoff ?? this.#admission
    const remainingMs = () =>
      Math.min(options.deadline.remainingMs(), permit?.deadline.remainingMs() ?? Infinity)
    if (permit) {
      const state = this.#permits.get(permit)
      if (!state || (this.#currentPermit && permit.generation < this.#currentPermit.generation))
        throw new TypeError(M.audit.closePermitForeign)
      if (!state.consumed) {
        state.consumed = true
        accelerated = true
        this.#fast = { cutoff, deadline: { remainingMs } }
      }
    }
    this.#cancel()
    while (this.#remaining(cutoff).records && remainingMs() > 0) {
      this.#pump()
      if (!this.#remaining(cutoff).records) break
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(5, remainingMs())))
    }
    if (accelerated && this.#fast?.cutoff === cutoff) this.#fast = undefined
    const pending = this.#remaining(cutoff)
    const deadlineExceeded = remainingMs() <= 0
    return {
      outcome:
        pending.records || this.#unknown || deadlineExceeded
          ? "incomplete"
          : this.#dropped
            ? "settled-with-loss"
            : "all-offered-written",
      cutoff,
      pendingRecords: pending.records,
      pendingBytes: pending.bytes,
      written: this.#written,
      dropped: this.#dropped,
      unknown: this.#unknown,
      accelerated,
      deadlineExceeded,
    }
  }
  /** 使用关闭许可结束缓冲区，返回最终结算结果。 */
  async close(permit: AuditClosePermit): Promise<AuditBufferFlushResult> {
    if (
      !this.#permits.has(permit) ||
      (this.#currentPermit && permit.generation < this.#currentPermit.generation)
    )
      throw new TypeError(M.audit.closePermitForeign)
    this.#closed = true
    let result = await this.flush({ deadline: permit.deadline, closePermit: permit })
    if (this.#normal.length || this.#critical) {
      // 一次性加速的接纳截止时间之后到达的来源，仅使用原有稳定速率。
      const late = await this.flush({ deadline: permit.deadline })
      result = {
        ...late,
        accelerated: result.accelerated || late.accelerated,
        deadlineExceeded: result.deadlineExceeded || late.deadlineExceeded,
      }
    }
    this.#cancel()
    const remaining = [...this.#normal, ...(this.#critical ? [this.#critical] : [])]
    this.#normal.length = 0
    this.#bytes = 0
    this.#critical = undefined
    for (const item of remaining) this.#settle(item, { result: "rejected", reason: "deadline" })
    return {
      ...result,
      dropped: this.#dropped,
      unknown: this.#unknown,
      outcome: remaining.length ? "incomplete" : result.outcome,
    }
  }
  /** 返回缓冲区计数快照。 */
  stats() {
    return {
      lastAdmissionSerial: this.#admission,
      offered: this.#offered,
      accepted: this.#accepted,
      written: this.#written,
      dropped: this.#dropped,
      unknown: this.#unknown,
      rejected: { ...this.#rejected },
      pendingRecords: this.#normal.length + Number(!!this.#critical) + this.#inFlight.size,
      pendingBytes:
        this.#bytes +
        this.#inFlightBytes +
        (this.#critical?.bytes ?? 0) +
        ([...this.#inFlight].find(item => item.critical)?.bytes ?? 0),
      ordinaryPending: this.#normal.length + this.#inFlightOrdinary,
      ordinaryPendingBytes: this.#bytes + this.#inFlightBytes,
      criticalPending: Number(!!this.#critical) + Number(this.#criticalInFlight),
      criticalCoalesced: this.#criticalCoalesced,
      criticalWriteFailed: this.#criticalWriteFailed,
      settlementErrors: this.#settlementErrors,
      highWaterRecords: this.#highWaterRecords,
      highWaterBytes: this.#highWaterBytes,
    }
  }
}
