export declare const auditProtocol: 1;
export declare const auditFrameBytes = 65536;
export declare const auditOrdinaryRecords = 4096;
export declare const auditOrdinaryBytes: number;
export type AuditClass = "ordinary" | "critical";
export type AuditLossReason = "queue-records" | "queue-bytes" | "oversize" | "serialization" | "send-error" | "disconnected" | "after-seal" | "sink-error" | "partial-write" | "deadline" | "unsequenced" | "rejected-frame";
export declare const auditLossReasons: readonly AuditLossReason[];
export type AuditLossCounts = Record<AuditLossReason, number>;
/** 创建各丢失原因均为 0 的计数表。 */
export declare function auditLossCounts(): AuditLossCounts;
export interface AuditDeadline {
    remainingMs(): number;
}
/** 创建基于单调时钟的剩余预算计时器。 */
export declare function createAuditDeadline(budgetMs: number, now?: () => number): AuditDeadline;
export interface AuditSourceCounters {
    offered: number;
    accepted: number;
    sendCompleted: number;
    hopReceived: number;
    unknown: number;
    invalidReplies: number;
    rejected: AuditLossCounts;
    criticalCoalesced: number;
    pendingRecords: number;
    pendingBytes: number;
    highWaterRecords: number;
    highWaterBytes: number;
}
/** 创建全零的来源计数器。 */
export declare function createAuditSourceCounters(): AuditSourceCounters;
export interface AuditObservationFrame {
    auditProtocol: 1;
    generation: number;
    channelNonce: string;
    type: "audit" | "violation";
    auditSeq: number;
    event: Record<string, unknown>;
}
export interface AuditHopAckFrame {
    auditProtocol: 1;
    generation: number;
    channelNonce: string;
    type: "audit-hop-ack";
    auditSeq: number;
    result: "received" | "rejected-frame";
}
export interface AuditPrepareFlushFrame {
    auditProtocol: 1;
    generation: number;
    channelNonce: string;
    type: "audit-prepare-flush";
    closeNonce: string;
    remainingBudgetMs: number;
    scope: "this-source-only";
}
export interface AuditSealFrame {
    auditProtocol: 1;
    generation: number;
    channelNonce: string;
    type: "audit-seal";
    closeNonce: string;
    /** 序号在实际发送时分配，不代表本地已排队的观察记录数。 */
    lastSentSeq: number;
    sourceCounters: AuditSourceCounters;
    nestedCoverage: "settled" | "incomplete" | "unknown";
}
export type AuditFlushOutcome = "all-offered-written" | "settled-with-loss" | "incomplete";
export interface AuditFlushResultFrame {
    auditProtocol: 1;
    generation: number;
    channelNonce: string;
    type: "audit-flush-result";
    closeNonce: string;
    cutoff: number;
    scope: "this-source-only";
    outcome: AuditFlushOutcome;
    receivedThrough: number;
    settledThrough: number;
    writtenThrough: number;
    writtenCount: number;
    rejectedCount: number;
    unknownCount: number;
    remainingCount: number;
    evidence: "host-append-completed" | "parent-hop-only";
}
export type AuditWireFrame = AuditObservationFrame | AuditHopAckFrame | AuditPrepareFlushFrame | AuditSealFrame | AuditFlushResultFrame;
/** 仅复制受限的自有数据；不执行访问器、Proxy 或 SDK 实例代码。 */
export declare function copyAuditData(value: unknown): unknown;
/** 只序列化已限界的纯数据，不执行继承的 toJSON。 */
export declare function stringifyAuditData(value: unknown): string;
/** 验证客体自报快照，不执行访问器，也不保留其对象。 */
export declare function parseAuditSourceCounters(value: unknown): AuditSourceCounters | undefined;
/** 仅处理审计；接收端必须另行绑定实际通道和当前代次。 */
export declare function parseAuditFrame(value: unknown): AuditWireFrame | undefined;
