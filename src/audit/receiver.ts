import { AuditBuffer, type AuditBufferSettlement, type AuditClosePermit } from "./buffer.js"
import {
  auditProtocol,
  auditOrdinaryRecords,
  parseAuditFrame,
  type AuditDeadline,
  type AuditFlushResultFrame,
  type AuditHopAckFrame,
  type AuditSealFrame,
} from "./protocol.js"
import { M } from "../shared/messages.js"

type Reply = (frame: AuditHopAckFrame | AuditFlushResultFrame) => void
/** 永久缺口只需保留一个边界，无须永久保存每个后续序号。 */
class Prefix {
  through = 0
  blockedAt = Infinity
  private completed: Array<{ first: number; last: number }> = []
  /** 已完成区间的数量。 */
  get ranges(): number {
    return this.completed.length
  }
  /** 从指定序号起阻断结算，并丢弃之后的已完成区间。 */
  block(sequence: number): void {
    this.blockedAt = Math.min(this.blockedAt, sequence)
    this.completed = this.completed.filter(item => item.first < this.blockedAt)
    for (const item of this.completed) item.last = Math.min(item.last, this.blockedAt - 1)
  }
  /** 登记一个序号已结算，必要时合并相邻区间。 */
  settle(sequence: number): boolean {
    if (sequence <= this.through || sequence >= this.blockedAt) return true
    let at = this.completed.findIndex(item => item.last >= sequence - 1)
    if (at < 0) at = this.completed.length
    const previous = this.completed[at]
    if (previous && previous.first <= sequence + 1) {
      previous.first = Math.min(previous.first, sequence)
      previous.last = Math.max(previous.last, sequence)
    } else this.completed.splice(at, 0, { first: sequence, last: sequence })
    while (
      this.completed[at + 1] &&
      this.completed[at]!.last >= this.completed[at + 1]!.first - 1
    ) {
      this.completed[at]!.last = Math.max(this.completed[at]!.last, this.completed[at + 1]!.last)
      this.completed.splice(at + 1, 1)
    }
    while (this.completed[0]?.first === this.through + 1)
      this.through = this.completed.shift()!.last
    if (this.completed.length <= auditOrdinaryRecords + 2) return true
    this.block(this.through + 1)
    return false
  }
}
interface Source {
  id: number
  key: string
  channelNonce: string
  transport: "primary-ipc" | "broker-connection"
  lastReceived: number
  receivedThrough: number
  receivedGap: boolean
  missing: number
  invalid: number
  written: number
  rejected: number
  unknown: number
  pending: Set<number>
  settled: Prefix
  appended: Prefix
  seal?: AuditSealFrame
  result?: AuditFlushResultFrame
  dropped: boolean
  transportUnknown: number
  finishing: boolean
  deadlineExceeded: boolean
}
/** 饱和求和，结果不超过最大安全整数。 */
const saturated = (...values: number[]) =>
  Math.min(
    Number.MAX_SAFE_INTEGER,
    values.reduce((sum, value) => sum + value, 0),
  )
export interface AuditReceiverOptions {
  generation: number
  buffer: AuditBuffer
  authorize(event: unknown): Record<string, unknown> | undefined
  /** 证据入队前执行已授权策略；审计帧不能决定动作。 */
  onAction(event: Record<string, unknown>): void
  onInvalid?(): void
}

/** 仅处理一个代次，以宿主持有的通道为键，不使用客体 PID 或运行时标签。 */
export class AuditReceiver {
  private readonly sources = new Map<string, Source>()
  private closeOptions?: { nonce: string; deadline: AuditDeadline }
  private permit?: AuditClosePermit
  private invalid = 0
  private nextSourceId = 0
  private retired = {
    sources: 0,
    sealed: 0,
    missingSeal: 0,
    written: 0,
    rejected: 0,
    unknown: 0,
    sourceRejected: 0,
    sourceCoalesced: 0,
    sourcePendingRecords: 0,
    allOfferedWritten: 0,
    settledWithLoss: 0,
    incomplete: 0,
  }
  /** 创建宿主端审计接收器。 */
  constructor(private readonly options: AuditReceiverOptions) {}
  /** 登记一个审计来源及其通道随机串。 */
  register(key: string, channelNonce: string, transport: Source["transport"]): void {
    if (
      this.sources.has(key) ||
      this.sources.size >= auditOrdinaryRecords + 130 ||
      this.nextSourceId >= Number.MAX_SAFE_INTEGER ||
      !/^[a-f0-9]{48}$/.test(channelNonce)
    )
      throw new Error(M.audit.sourceBinding)
    this.sources.set(key, {
      id: ++this.nextSourceId,
      key,
      channelNonce,
      transport,
      lastReceived: 0,
      receivedThrough: 0,
      receivedGap: false,
      missing: 0,
      invalid: 0,
      written: 0,
      rejected: 0,
      unknown: 0,
      pending: new Set(),
      settled: new Prefix(),
      appended: new Prefix(),
      dropped: false,
      transportUnknown: 0,
      finishing: false,
      deadlineExceeded: false,
    })
  }
  /** 进入关闭阶段并记录截止时间。 */
  prepare(options: { nonce: string; deadline: AuditDeadline }): void {
    if (!/^[a-f0-9]{48}$/.test(options.nonce)) throw new Error(M.audit.closeNonce)
    if (this.closeOptions && this.closeOptions !== options) {
      if (this.closeOptions.nonce !== options.nonce) throw new Error(M.audit.closeNonceChanged)
      return
    }
    this.closeOptions = options
  }
  /** 累计无效帧数量。 */
  private bad(source?: Source): void {
    this.invalid++
    if (source) source.invalid++
    this.options.onInvalid?.()
  }
  /** 接收并校验来源发来的一帧，按类型入队、结算或回复。 */
  receive(key: string, raw: unknown, reply: Reply): boolean {
    const source = this.sources.get(key)
    const frame = parseAuditFrame(raw)
    if (
      !source ||
      !frame ||
      frame.generation !== this.options.generation ||
      frame.channelNonce !== source.channelNonce ||
      source.dropped
    ) {
      this.bad(source)
      return false
    }
    if (frame.type === "audit-seal") {
      if (
        !this.closeOptions ||
        frame.closeNonce !== this.closeOptions.nonce ||
        source.seal ||
        frame.lastSentSeq < source.lastReceived
      ) {
        this.bad(source)
        return false
      }
      source.seal = frame
      source.finishing = true
      void this.finishSource(source, reply)
        .catch(() => {
          source.unknown++
          this.bad(source)
        })
        .finally(() => {
          source.finishing = false
          this.retire(source)
        })
      return true
    }
    if (
      (frame.type !== "audit" && frame.type !== "violation") ||
      source.seal ||
      frame.auditSeq <= source.lastReceived
    ) {
      this.bad(source)
      return false
    }
    const sequence = frame.auditSeq
    if (sequence > source.lastReceived + 1) {
      source.missing += sequence - source.lastReceived - 1
      source.receivedGap = true
      source.settled.block(source.lastReceived + 1)
      source.appended.block(source.lastReceived + 1)
    }
    source.lastReceived = sequence
    if (!source.receivedGap) source.receivedThrough = sequence
    let event: Record<string, unknown> | undefined
    try {
      event = this.options.authorize(frame.event)
    } catch {
      source.unknown++
      source.settled.block(sequence)
      source.appended.block(sequence)
      this.bad(source)
      this.reply(source, reply, {
        auditProtocol,
        generation: this.options.generation,
        channelNonce: source.channelNonce,
        type: "audit-hop-ack",
        auditSeq: sequence,
        result: "rejected-frame",
      })
      return false
    }
    if (!event) {
      source.rejected++
      if (!source.settled.settle(sequence)) source.unknown++
      source.appended.block(sequence)
      this.bad(source)
      this.reply(source, reply, {
        auditProtocol,
        generation: this.options.generation,
        channelNonce: source.channelNonce,
        type: "audit-hop-ack",
        auditSeq: sequence,
        result: "rejected-frame",
      })
      return false
    }
    // 即使审计队列或写入器已满，回调仍可立即安排恢复。
    try {
      this.options.onAction(event)
    } catch {
      source.unknown++
      source.settled.block(sequence)
      source.appended.block(sequence)
      this.bad(source)
      this.reply(source, reply, {
        auditProtocol,
        generation: this.options.generation,
        channelNonce: source.channelNonce,
        type: "audit-hop-ack",
        auditSeq: sequence,
        result: "rejected-frame",
      })
      return false
    }
    source.pending.add(sequence)
    this.options.buffer.offer(
      {
        type: event.action === "restart" ? "violation" : "audit",
        details: { generation: this.options.generation, event },
        time: Date.now(),
      },
      {
        critical: event.action === "deny" || event.action === "restart",
        onSettled: receipt => this.settle(source, sequence, receipt),
      },
    )
    this.reply(source, reply, {
      auditProtocol,
      generation: this.options.generation,
      channelNonce: source.channelNonce,
      type: "audit-hop-ack",
      auditSeq: sequence,
      result: "received",
    })
    return true
  }
  /** 处理缓冲区回执，更新来源的待结算与已写入状态。 */
  private settle(source: Source, sequence: number, receipt: AuditBufferSettlement): void {
    if (!source.pending.delete(sequence)) {
      source.unknown++
      return
    }
    if (receipt.result === "written") {
      source.written++
      if (!source.settled.settle(sequence)) source.unknown++
      if (!source.appended.settle(sequence)) source.unknown++
    } else {
      source.appended.block(sequence)
      if (receipt.result === "rejected") {
        source.rejected++
        if (!source.settled.settle(sequence)) source.unknown++
      } else {
        source.unknown++
        source.settled.block(sequence)
      }
    }
    this.retire(source)
  }
  /** 向来源回复确认帧。 */
  private reply(
    source: Source,
    reply: Reply,
    frame: AuditHopAckFrame | AuditFlushResultFrame,
  ): void {
    try {
      reply(frame)
    } catch {
      source.transportUnknown = saturated(source.transportUnknown, 1)
    }
  }
  /** 出站通道操作失败只记为一次事件，不等同于丢失审计记录数。 */
  noteOutboundFailure(key: string): void {
    const source = this.sources.get(key)
    if (source) source.transportUnknown = saturated(source.transportUnknown, 1)
  }
  /** 惰性创建本代次的关闭许可。 */
  private closePermit(): AuditClosePermit {
    if (!this.closeOptions) throw new Error(M.audit.closeUnprepared)
    return (this.permit ??= this.options.buffer.createClosePermit({
      generation: this.options.generation,
      ...this.closeOptions,
    }))
  }
  /** 来源已密封时，等待其事件结算后回复最终结果。 */
  private async finishSource(source: Source, reply: Reply): Promise<void> {
    const close = this.closeOptions!,
      seal = source.seal!
    const permit = this.closePermit()
    // 宿主仅授予一次有限加速，接纳截止时间及完成期限均固定。
    const flushed = source.pending.size
      ? await this.options.buffer.flush({ deadline: close.deadline, closePermit: permit })
      : undefined
    while (source.pending.size && close.deadline.remainingMs() > 0)
      await new Promise(resolve => setTimeout(resolve, Math.min(5, close.deadline.remainingMs())))
    const counters = seal.sourceCounters
    const localLoss =
      Object.values(counters.rejected).reduce((sum, value) => sum + value, 0) +
      counters.criticalCoalesced
    const missingTail = Math.max(0, seal.lastSentSeq - source.lastReceived)
    const unknown = saturated(
      source.unknown,
      source.missing,
      missingTail,
      source.transportUnknown,
      source.invalid,
      counters.unknown,
      counters.invalidReplies,
    )
    const remaining = source.pending.size
    source.deadlineExceeded = Boolean(
      flushed?.deadlineExceeded || close.deadline.remainingMs() <= 0,
    )
    const incomplete =
      unknown > 0 ||
      remaining > 0 ||
      counters.pendingRecords > 0 ||
      seal.nestedCoverage !== "settled" ||
      flushed?.outcome === "incomplete" ||
      source.deadlineExceeded
    const loss = localLoss + source.rejected
    source.result = {
      auditProtocol,
      generation: this.options.generation,
      channelNonce: source.channelNonce,
      type: "audit-flush-result",
      closeNonce: close.nonce,
      cutoff: seal.lastSentSeq,
      scope: "this-source-only",
      outcome: incomplete
        ? "incomplete"
        : loss
          ? "settled-with-loss"
          : counters.offered === seal.lastSentSeq && source.written === seal.lastSentSeq
            ? "all-offered-written"
            : "incomplete",
      receivedThrough: source.receivedThrough,
      settledThrough: source.settled.through,
      writtenThrough: source.appended.through,
      writtenCount: source.written,
      rejectedCount: source.rejected,
      unknownCount: unknown,
      remainingCount: remaining,
      evidence: "host-append-completed",
    }
    this.reply(source, reply, source.result)
  }
  /** 来源断开时记录未知数量并退役。 */
  drop(key: string, transportUnknown = 0): void {
    const source = this.sources.get(key)
    if (!source) return
    source.dropped = true
    source.transportUnknown =
      Number.isSafeInteger(transportUnknown) && transportUnknown >= 0
        ? saturated(source.transportUnknown, transportUnknown)
        : Number.MAX_SAFE_INTEGER
    this.retire(source)
  }
  /** 把短期来源的统计并入退役汇总，释放活动名额。 */
  private retire(source: Source): void {
    if (
      source.transport === "primary-ipc" ||
      !source.dropped ||
      source.pending.size ||
      source.finishing ||
      this.sources.get(source.key) !== source
    )
      return
    this.sources.delete(source.key)
    const total = this.retired
    total.sources = saturated(total.sources, 1)
    total.sealed = saturated(total.sealed, Number(Boolean(source.seal)))
    total.missingSeal = saturated(total.missingSeal, Number(!source.seal))
    total.written = saturated(total.written, source.written)
    total.rejected = saturated(total.rejected, source.rejected)
    const local = this.sourceLoss(source)
    total.unknown = saturated(total.unknown, local.unknown)
    total.sourceRejected = saturated(total.sourceRejected, local.rejected)
    total.sourceCoalesced = saturated(total.sourceCoalesced, local.coalesced)
    total.sourcePendingRecords = saturated(total.sourcePendingRecords, local.pendingRecords)
    if (source.result?.outcome === "all-offered-written" && !local.unknown)
      total.allOfferedWritten++
    else if (source.result?.outcome === "settled-with-loss" && !local.unknown)
      total.settledWithLoss++
    else total.incomplete++
  }
  /** 在关闭截止时间内提交全部已接收事件。 */
  async flush(): Promise<void> {
    if (!this.closeOptions) throw new Error(M.audit.closeUnprepared)
    await this.options.buffer.flush({
      deadline: this.closeOptions.deadline,
      closePermit: this.closePermit(),
    })
  }
  /** 返回宿主关闭缓冲区所需的许可。 */
  closePermitForHost(): AuditClosePermit {
    return this.closePermit()
  }
  /** 汇总来源自报与接收端观测到的丢失数量。 */
  private sourceLoss(source: Source) {
    const counters = source.seal?.sourceCounters
    return {
      unknown: Math.max(
        source.result?.unknownCount ?? 0,
        saturated(
          source.unknown,
          source.missing,
          source.transportUnknown,
          source.invalid,
          counters?.unknown ?? 0,
          counters?.invalidReplies ?? 0,
          Math.max(0, (source.seal?.lastSentSeq ?? source.lastReceived) - source.lastReceived),
        ),
      ),
      rejected: counters ? saturated(...Object.values(counters.rejected)) : 0,
      coalesced: counters?.criticalCoalesced ?? 0,
      pendingRecords: counters?.pendingRecords ?? 0,
    }
  }
  /** 返回接收器与各来源的统计快照。 */
  stats() {
    return {
      generation: this.options.generation,
      invalidFrames: this.invalid,
      retired: { ...this.retired },
      sources: [...this.sources.values()].map(source => ({
        sourceId: source.id,
        transport: source.transport,
        received: source.lastReceived,
        receivedThrough: source.receivedThrough,
        written: source.written,
        rejected: source.rejected,
        unknown: this.sourceLoss(source).unknown,
        sourceLoss: this.sourceLoss(source),
        transportUnknown: source.transportUnknown,
        pending: source.pending.size,
        sealed: Boolean(source.seal),
        bookkeepingRanges: source.settled.ranges + source.appended.ranges,
        deadlineExceeded: source.deadlineExceeded,
        receiptDelivery: "unconfirmed",
        outcome: this.sourceLoss(source).unknown
          ? "incomplete"
          : (source.result?.outcome ?? "incomplete"),
        nestedCoverage: source.seal?.nestedCoverage ?? "unknown",
        evidence: source.result?.evidence ?? "unconfirmed",
        dropped: source.dropped,
      })),
    }
  }
}
