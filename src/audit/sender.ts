import {
  auditFrameBytes,
  auditOrdinaryBytes,
  auditProtocol,
  copyAuditData,
  createAuditSourceCounters,
  stringifyAuditData,
  type AuditDeadline,
  type AuditHopAckFrame,
  type AuditLossReason,
  type AuditObservationFrame,
  type AuditSealFrame,
  type AuditSourceCounters,
} from "./protocol.js"
import {
  arrayEach,
  arrayIsArray,
  arrayPush,
  arrayShift,
  bufferByteLength,
  mapDelete,
  mapEach,
  mapGet,
  mapHas,
  mapSet,
  mathMax,
  mathMin,
  newMap,
  numberIsSafeInteger,
  promiseReject,
  regexpTest,
} from "../protect/intrinsics.js"
import { M } from "../shared/messages.js"

const AsyncPromise = Promise
const schedule = setTimeout
const unboundNonce = "x".repeat(128)
const maxSequence = Number.MAX_SAFE_INTEGER

interface Delivery {
  event: Record<string, unknown>
  bytes: number
  lane?: "deny" | "restart"
  seq?: number
  done: boolean
  callbackDone: boolean
}
export interface AuditSenderOptions {
  generation: number
  maxQueue: number
  maxBytes?: number
  channelNonce?: string
  completion: "callback" | "hop"
  write(frame: AuditObservationFrame, callback: (error?: Error | null) => void): boolean | void
  isConnected(): boolean
  now?: () => number
}
export type AuditSenderOffer =
  { accepted: true } | { accepted: false; reason: AuditLossReason | "critical-coalesced" }

/** 有限的传输投递，不代表宿主追加落盘或策略授权回执。 */
export class AuditSender {
  readonly #options: AuditSenderOptions
  readonly #counts = createAuditSourceCounters()
  readonly #normal: Delivery[] = []
  readonly #critical = newMap<"deny" | "restart", Delivery>()
  readonly #inFlight = newMap<number, Delivery>()
  #ordinaryCount = 0
  #ordinaryBytes = 0
  #nonce?: string
  #sequence = 0
  #pumping = false
  #paused = false
  #sealed = false
  #disposed = false
  #sealNonce?: string
  #sealPromise?: Promise<AuditSealFrame>
  #sealResult?: AuditSealFrame

  /** 创建工作进程端审计发送器。 */
  constructor(options: AuditSenderOptions) {
    if (
      !numberIsSafeInteger(options.generation) ||
      options.generation < 1 ||
      !numberIsSafeInteger(options.maxQueue) ||
      options.maxQueue < 1 ||
      (options.maxBytes !== undefined &&
        (!numberIsSafeInteger(options.maxBytes) || options.maxBytes < 1))
    )
      throw new TypeError(M.audit.senderLimits)
    this.#options = options
    if (options.channelNonce !== undefined && !this.bindChannel(options.channelNonce))
      throw new TypeError(M.audit.channelNonce)
  }
  /** 读取通道连接状态，读取异常视为断开。 */
  #connected(): boolean {
    try {
      return this.#options.isConnected()
    } catch {
      return false
    }
  }
  /** 绑定宿主下发的通道随机串，只能绑定一次。 */
  bindChannel(nonce: string): boolean {
    if (
      typeof nonce !== "string" ||
      !regexpTest(/^[a-zA-Z0-9_-]{16,128}$/, nonce) ||
      (this.#nonce && this.#nonce !== nonce)
    )
      return false
    this.#nonce = nonce
    this.#pump()
    return true
  }
  /** 提交一条事件，返回接受结果或拒绝原因。 */
  offer(event: Record<string, unknown>, critical = false): AuditSenderOffer {
    this.#counts.offered++
    const reject = (reason: AuditLossReason): AuditSenderOffer => {
      this.#counts.rejected[reason]++
      return { accepted: false, reason }
    }
    if (this.#sealResult) return reject("after-seal")
    if (this.#disposed || !this.#connected()) return reject("disconnected")
    if (this.#sealed && !critical) return reject("after-seal")
    let copy: Record<string, unknown>
    let bytes: number
    try {
      copy = copyAuditData(event) as Record<string, unknown>
      if (!copy || typeof copy !== "object" || arrayIsArray(copy)) return reject("serialization")
      bytes = bufferByteLength(
        stringifyAuditData({
          auditProtocol,
          generation: this.#options.generation,
          channelNonce: this.#nonce ?? unboundNonce,
          type: "violation",
          auditSeq: maxSequence,
          event: copy,
        }),
      )
    } catch {
      return reject("serialization")
    }
    if (bytes > auditFrameBytes) return reject("oversize")
    let lane: "deny" | "restart" | undefined = critical
      ? copy.action === "restart"
        ? "restart"
        : "deny"
      : undefined
    // 每条关键通道只占一个不受限额约束的槽位。重启在途时再请求重启没有意义；
    // 拒绝记录则改走普通队列，避免连续拦截只留下第一条。
    const fallback = Boolean(lane && mapHas(this.#critical, lane))
    const coalesced = (): AuditSenderOffer => {
      this.#counts.criticalCoalesced++
      return { accepted: false, reason: "critical-coalesced" }
    }
    if (fallback) {
      if (lane === "restart") return coalesced()
      lane = undefined
    }
    const maximum =
      this.#options.maxBytes ??
      mathMin(auditOrdinaryBytes, this.#options.maxQueue * auditFrameBytes)
    if (!lane && this.#ordinaryCount >= this.#options.maxQueue)
      return fallback ? coalesced() : reject("queue-records")
    if (!lane && this.#ordinaryBytes + bytes > maximum)
      return fallback ? coalesced() : reject("queue-bytes")
    const item: Delivery = { event: copy, bytes, lane, done: false, callbackDone: false }
    if (lane) mapSet(this.#critical, lane, item)
    else {
      arrayPush(this.#normal, item)
      this.#ordinaryCount++
      this.#ordinaryBytes += bytes
    }
    this.#counts.accepted++
    this.#counts.pendingRecords++
    this.#counts.pendingBytes += bytes
    this.#counts.highWaterRecords = mathMax(
      this.#counts.highWaterRecords,
      this.#counts.pendingRecords,
    )
    this.#counts.highWaterBytes = mathMax(this.#counts.highWaterBytes, this.#counts.pendingBytes)
    this.#pump()
    return { accepted: true }
  }
  /** 结束一条投递并记录拒绝原因或未知结果。 */
  #finish(item: Delivery, reason?: AuditLossReason, unknown = false): void {
    if (item.done) return
    item.done = true
    if (reason) this.#counts.rejected[reason]++
    if (unknown) this.#counts.unknown++
    if (item.seq !== undefined) mapDelete(this.#inFlight, item.seq)
    if (item.lane) {
      if (mapGet(this.#critical, item.lane) === item) mapDelete(this.#critical, item.lane)
    } else {
      this.#ordinaryCount--
      this.#ordinaryBytes -= item.bytes
    }
    this.#counts.pendingRecords--
    this.#counts.pendingBytes -= item.bytes
  }
  /** 在通道可写时按顺序发送待投递事件。 */
  #pump(): void {
    if (this.#pumping || this.#paused || this.#disposed || !this.#nonce) return
    this.#pumping = true
    try {
      while (!this.#paused && this.#connected()) {
        let item = mapGet(this.#critical, "restart")
        if (!item || item.seq !== undefined) item = mapGet(this.#critical, "deny")
        if (!item || item.seq !== undefined) item = arrayShift(this.#normal)
        if (!item) break
        if (item.done) continue
        if (this.#sequence === maxSequence) {
          this.#finish(item, "send-error", true)
          continue
        }
        item.seq = ++this.#sequence
        mapSet(this.#inFlight, item.seq, item)
        const frame: AuditObservationFrame = {
          auditProtocol,
          generation: this.#options.generation,
          channelNonce: this.#nonce,
          type: item.event.action === "restart" ? "violation" : "audit",
          auditSeq: item.seq,
          event: item.event,
        }
        try {
          const writable = this.#options.write(frame, error => {
            if (item.callbackDone) return
            item.callbackDone = true
            if (item.done) {
              if (!error) this.#counts.sendCompleted++
              else this.#counts.rejected["send-error"]++
              return
            }
            if (error) this.#finish(item, "send-error", true)
            else {
              this.#counts.sendCompleted++
              if (this.#options.completion === "callback") this.#finish(item)
            }
            this.#pump()
          })
          if (writable === false) this.#paused = true
        } catch {
          this.#finish(item, "send-error", true)
        }
      }
    } finally {
      this.#pumping = false
    }
  }
  /** 处理宿主确认帧，返回是否为有效确认。 */
  ack(frame: AuditHopAckFrame): boolean {
    if (
      this.#disposed ||
      this.#options.completion !== "hop" ||
      frame.auditProtocol !== auditProtocol ||
      frame.generation !== this.#options.generation ||
      frame.channelNonce !== this.#nonce
    )
      return false
    const item = mapGet(this.#inFlight, frame.auditSeq)
    if (!item) return false
    if (frame.result === "received") {
      this.#counts.hopReceived++
      this.#finish(item)
    } else if (frame.result === "rejected-frame") this.#finish(item, "rejected-frame")
    else return false
    this.#pump()
    return true
  }
  /** 通道可写后恢复发送。 */
  resume(): void {
    this.#paused = false
    this.#pump()
  }
  /** 返回计数器副本。 */
  counters(): AuditSourceCounters {
    return { ...this.#counts, rejected: { ...this.#counts.rejected } }
  }
  /** 立即生成密封帧，不等待在途事件。 */
  sealNow(options: {
    nonce: string
    nestedCoverage?: AuditSealFrame["nestedCoverage"]
  }): AuditSealFrame {
    if (
      !regexpTest(/^[a-zA-Z0-9_-]{16,128}$/, options.nonce) ||
      (this.#sealNonce && this.#sealNonce !== options.nonce)
    )
      throw new TypeError(M.audit.sealNonceChanged)
    if (this.#sealResult) return this.#sealResult
    this.#sealed = true
    this.#sealNonce = options.nonce
    this.#finishAll("deadline")
    this.#normal.length = 0
    if (!this.#nonce) throw new Error(M.audit.sourceUnbound)
    this.#sealResult = {
      auditProtocol,
      generation: this.#options.generation,
      channelNonce: this.#nonce,
      type: "audit-seal",
      closeNonce: options.nonce,
      lastSentSeq: this.#sequence,
      sourceCounters: this.counters(),
      nestedCoverage: options.nestedCoverage ?? "unknown",
    }
    return this.#sealResult
  }
  /** 在截止时间内等待在途事件后发送密封帧。 */
  seal(options: {
    nonce: string
    deadline: AuditDeadline
    nestedCoverage?: AuditSealFrame["nestedCoverage"]
  }): Promise<AuditSealFrame> {
    if (!regexpTest(/^[a-zA-Z0-9_-]{16,128}$/, options.nonce))
      return promiseReject(new TypeError(M.audit.sealNonce))
    if (this.#sealNonce && this.#sealNonce !== options.nonce)
      return promiseReject(new TypeError(M.audit.sealNonceChanged))
    if (this.#sealPromise) return this.#sealPromise
    this.#sealed = true
    this.#sealNonce = options.nonce
    this.#sealPromise = (async () => {
      this.#pump()
      while (this.#counts.pendingRecords && options.deadline.remainingMs() > 0) {
        await new AsyncPromise<void>(resolve =>
          schedule(resolve, mathMin(5, options.deadline.remainingMs())),
        )
        this.#pump()
      }
      return this.sealNow(options)
    })()
    return this.#sealPromise
  }
  /** 停止发送并把未完成事件记为断开。 */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#sealed = true
    this.#finishAll("disconnected")
    this.#normal.length = 0
  }
  /** 以同一原因结束全部未完成投递。 */
  #finishAll(reason: AuditLossReason): void {
    const finish = (item: Delivery) => this.#finish(item, reason, item.seq !== undefined)
    arrayEach(this.#normal, finish)
    mapEach(this.#inFlight, finish)
    mapEach(this.#critical, finish)
  }
}
