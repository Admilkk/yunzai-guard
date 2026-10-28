import type { AuditAppendReceipt, AuditSinkFrame } from "./sink.js";
export interface SqliteAuditOptions {
    filePath: string;
    maxBytes: number;
    maxFiles: number;
    /** 默认 full；宿主按配置传入 adaptive。 */
    durability?: "adaptive" | "full";
    hostPid?: number;
    wallNow?: () => number;
}
export declare class SqliteAuditSink {
    #private;
    /** 打开 SQLite 审计存储并准备语句。 */
    constructor(options: SqliteAuditOptions);
    /** 删除早于保留天数的事件，返回删除条数；days 为 0 时不处理。 */
    pruneByAge(days: number, now?: number): number;
    /** 更新保留预算并立即淘汰超出部分。 */
    updateLimits(options: Pick<SqliteAuditOptions, "maxBytes" | "maxFiles">): void;
    /** 批量写入事件，逐条返回回执。 */
    appendBatch(frames: readonly AuditSinkFrame[]): AuditAppendReceipt[];
    /** 写入单条事件。 */
    record(type: string, details?: Record<string, unknown>, time?: number): AuditAppendReceipt;
    /** 返回存储统计快照。 */
    stats(): {
        error?: string | undefined;
        lastAllocatedSequence: number;
        available: boolean;
        framingUnknown: boolean;
        written: number;
        rejected: number;
        unknown: number;
        filesEvicted: number;
        bytesEvicted: number;
        rotationCoverageUnknown: boolean;
        evidence: "sqlite-transaction-committed";
        storage: "sqlite";
        path: string;
        retainedRecords: number;
        retainedBytes: number;
        evictedRecords: number;
        retentionBytes: number;
    };
    /** 关闭数据库，可重复调用。 */
    close(): void;
}
