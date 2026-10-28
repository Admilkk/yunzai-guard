import type { GuardAction, GuardSettings } from "../shared/types.js";
type Row = Record<string, unknown>;
type AuditAction = GuardAction | "info";
export interface AuditQuery {
    page?: unknown;
    pageSize?: unknown;
    plugin?: unknown;
    kind?: unknown;
    action?: unknown;
    q?: unknown;
    from?: unknown;
    to?: unknown;
    scope?: unknown;
}
export interface AuditEntry {
    id: string;
    time: number;
    type: string;
    sequence?: number;
    hostPid?: number;
    generation?: number;
    plugin: string;
    kind: string;
    operation: string;
    target: string;
    action: AuditAction;
    ruleId?: string;
    blocked?: boolean;
    details: Row;
}
export interface AuditCoverage {
    source: "retained-audit-window" | "sqlite-history";
    complete: false;
    truncated: boolean;
    bytesRead: number;
    recordsRead: number;
    invalidLines: number;
    filesRead: number;
    filesSkipped: number;
    errors: string[];
    windowStart?: number;
    windowEnd?: number;
    lossReported: boolean;
    latestReports: AuditEntry[];
}
export interface AuditSummary {
    total: number;
    audit: number;
    deny: number;
    restart: number;
    info: number;
    unknownPlugin: number;
    kinds: Record<string, number>;
    timeline: {
        time: number;
        total: number;
        audit: number;
        deny: number;
        restart: number;
        info: number;
    }[];
    windowStart?: number;
    windowEnd?: number;
}
export interface AuditPage {
    items: AuditEntry[];
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
    summary: AuditSummary;
    facets: {
        plugins: string[];
        kinds: string[];
        actions: AuditAction[];
    };
    coverage: AuditCoverage;
    storage?: {
        engine: "sqlite";
        available: boolean;
        retainedRecords: number;
        retainedBytes: number;
        evictedRecords: number;
        legacyImported?: number;
    };
}
/**
 * 分页读取审计事件。面板多个卡片会在同一时刻发出相同查询，
 * 文件未变化时 2 秒内直接复用结果，避免重复扫描与汇总。
 */
export declare function readAudit(stateDir: string, input?: AuditQuery | URLSearchParams): AuditPage;
/** 已记录的原生扩展加载，按插件与路径去重，最新在前。 */
export declare function nativeExtensions(stateDir: string): {
    plugin: string;
    target: string;
    lastAt: number;
    count: number;
}[];
/** 汇总各插件的规则、最近活动与统计。 */
export declare function pluginMonitor(root: string, settings: GuardSettings, snapshot?: AuditPage): {
    stats: {
        lastEventAt?: number | undefined;
        total: number;
        audit: number;
        deny: number;
        restart: number;
    };
    lastEvent: AuditEntry;
    rules: {
        id: string;
        kind?: string | string[];
        plugin?: string;
        operation?: string;
        target?: string;
        action: GuardAction;
        index: number;
    }[];
    permissions: {
        enforcement: string;
        conditional: boolean;
        action: GuardAction;
        ruleId?: string;
        id: string;
        label: string;
        sample: {
            kind: string;
            operation: string;
            target: string;
        };
    }[];
    sandbox: {
        config?: import("../native-sandbox/types.js").NativeSandboxPlugin | undefined;
        enabled: boolean;
    };
    statsScope: string;
    id: string;
    reserved: boolean;
    description?: string;
}[];
export {};
