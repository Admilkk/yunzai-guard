import type { AuditPage } from "./monitor.js";
export interface CompareWindow {
    from: number;
    to: number;
}
export interface WindowStats {
    from: number;
    to: number;
    total: number;
    blocked: number;
    kinds: Record<string, number>;
    /** 读取达到上限时为 true，统计只覆盖窗口内较新的部分。 */
    truncated: boolean;
}
export interface TargetDelta {
    kind: string;
    operation: string;
    target: string;
    a: number;
    b: number;
}
export interface AuditComparison {
    plugin?: string;
    a: WindowStats;
    b: WindowStats;
    /** 只在 B 出现的行为。 */
    added: TargetDelta[];
    /** 只在 A 出现的行为。 */
    removed: TargetDelta[];
    /** 两边都有但次数明显变化的行为。 */
    changed: TargetDelta[];
}
/** 对比两个时间窗口内的行为，用于判断更新或改配置之后插件做了什么新事。 */
export declare function compareAudit(read: (params: URLSearchParams) => AuditPage, windows: {
    a: CompareWindow;
    b: CompareWindow;
}, plugin?: string): AuditComparison;
