import { type AuditDeadline, type AuditLossReason, type AuditFlushOutcome } from "./protocol.js";
import type { AuditAppendReceipt, AuditSink, AuditSinkFrame } from "./sink.js";
export type AuditBufferSettlement = AuditAppendReceipt | {
    result: "rejected";
    reason: "critical-coalesced";
} | {
    result: "unknown";
    reason: "sink-error";
    sequence?: number;
};
export type AuditBufferOffer = {
    accepted: true;
    admissionSerial: number;
} | {
    accepted: false;
    reason: AuditLossReason | "critical-coalesced";
};
export interface AuditBufferOptions {
    sink: Pick<AuditSink, "appendBatch">;
    maxEventsPerSecond: number;
    maxBytes: number;
    now?: () => number;
    setTimer?: (callback: () => void, delay: number) => unknown;
    clearTimer?: (timer: unknown) => void;
}
export type AuditBufferLimits = Pick<AuditBufferOptions, "maxEventsPerSecond" | "maxBytes">;
declare const permitBrand: unique symbol;
export interface AuditClosePermit {
    readonly [permitBrand]: true;
    readonly generation: number;
    readonly nonce: string;
    readonly acceleratedCutoff: number;
    readonly deadline: AuditDeadline;
}
export interface AuditBufferFlushResult {
    outcome: AuditFlushOutcome;
    cutoff: number;
    pendingRecords: number;
    pendingBytes: number;
    written: number;
    dropped: number;
    unknown: number;
    accelerated: boolean;
    deadlineExceeded: boolean;
}
/** 仅接收已授权的不可变观察记录；策略决策必须先于 offer()。 */
export declare class AuditBuffer {
    #private;
    /** 创建审计缓冲区。 */
    constructor(options: AuditBufferOptions);
    /** 运行时更新速率与容量上限，已有令牌按新上限截断。 */
    updateLimits(limits: AuditBufferLimits): void;
    /** 提交一帧审计数据；关键事件优先且不受速率限制。 */
    offer(frame: AuditSinkFrame, options?: {
        critical?: boolean;
        onSettled?: (receipt: AuditBufferSettlement) => void;
    }): AuditBufferOffer;
    /** 为指定代次创建关闭许可，供 flush/close 使用。 */
    createClosePermit(options: {
        generation: number;
        nonce: string;
        deadline: AuditDeadline;
    }): AuditClosePermit;
    /** 在截止时间内尽量提交已接收的事件，并返回结算摘要。 */
    flush(options: {
        deadline: AuditDeadline;
        closePermit?: AuditClosePermit;
    }): Promise<AuditBufferFlushResult>;
    /** 使用关闭许可结束缓冲区，返回最终结算结果。 */
    close(permit: AuditClosePermit): Promise<AuditBufferFlushResult>;
    /** 返回缓冲区计数快照。 */
    stats(): {
        lastAdmissionSerial: number;
        offered: number;
        accepted: number;
        written: number;
        dropped: number;
        unknown: number;
        rejected: {
            "queue-records": number;
            "queue-bytes": number;
            oversize: number;
            serialization: number;
            "send-error": number;
            disconnected: number;
            "after-seal": number;
            "sink-error": number;
            "partial-write": number;
            deadline: number;
            unsequenced: number;
            "rejected-frame": number;
        };
        pendingRecords: number;
        pendingBytes: number;
        ordinaryPending: number;
        ordinaryPendingBytes: number;
        criticalPending: number;
        criticalCoalesced: number;
        criticalWriteFailed: number;
        settlementErrors: number;
        highWaterRecords: number;
        highWaterBytes: number;
    };
}
export {};
