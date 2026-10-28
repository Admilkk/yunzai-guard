import { type AuditLossReason } from "./protocol.js";
export interface AuditSinkFrame {
    type: string;
    details?: Record<string, unknown>;
    time?: number;
}
export type AuditAppendReceipt = {
    result: "written";
    sequence: number;
    bytes: number;
} | {
    result: "rejected";
    reason: AuditLossReason;
    sequence?: number;
} | {
    result: "unknown";
    reason: "partial-write";
    sequence: number;
};
export interface AuditSinkIO {
    exists(file: string): boolean;
    size(file: string): number;
    rename(source: string, target: string): void;
    truncate(file: string): void;
    append(file: string, text: string): void;
}
export interface AuditSinkOptions {
    filePath: string;
    maxBytes: number;
    maxFiles: number;
    hostPid?: number;
    wallNow?: () => number;
    io?: AuditSinkIO;
}
/** 唯一的同步写入器；回执仅表示追加完成，不保证 fsync 或最终留存。 */
export declare class AuditSink {
    #private;
    /** 创建按大小轮转的 JSONL 审计落盘端。 */
    constructor(options: AuditSinkOptions);
    /** 批量追加事件，逐条返回写入回执。 */
    appendBatch(frames: readonly AuditSinkFrame[]): AuditAppendReceipt[];
    /** 追加单条事件。 */
    record(type: string, details?: Record<string, unknown>, time?: number): AuditAppendReceipt;
    /** 返回落盘统计快照。 */
    stats(): {
        lastAllocatedSequence: number;
        available: boolean;
        framingUnknown: boolean;
        written: number;
        rejected: number;
        unknown: number;
        filesEvicted: number;
        bytesEvicted: number;
        rotationCoverageUnknown: boolean;
        evidence: "append-completed-without-fsync";
    };
}
