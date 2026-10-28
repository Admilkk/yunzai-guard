import type { AuditEntry, AuditPage } from "./monitor.js";
type EntryParser = (value: unknown, id: string) => AuditEntry | undefined;
export interface SqliteAuditQuery {
    page: number;
    pageSize: number;
    plugin?: string;
    kind?: string;
    action?: string;
    q?: string;
    from?: number;
    to?: number;
    /** behavior 只返回业务行为，排除宿主系统记录。 */
    scope?: "behavior";
}
export interface SqlitePluginStats {
    total: number;
    audit: number;
    deny: number;
    restart: number;
    lastEvent?: AuditEntry;
}
/** 趋势图的时间分桶上限。 */
export declare const timelineBuckets = 24;
/** 选择不超过分桶上限的最小整齐分桶，返回桶长与对齐后的起点。 */
export declare function timelineBucket(windowStart: number, windowEnd: number): {
    size: number;
    start: number;
};
/** 按条件分页读取 SQLite 审计事件。 */
export declare function readSqliteAudit(file: string, query: SqliteAuditQuery, parse: EntryParser): AuditPage;
/** 按插件汇总事件数量与最近活动时间。 */
export declare function readSqlitePluginStats(file: string, plugins: string[], parse: EntryParser): Map<string, SqlitePluginStats>;
export {};
