import type { SettingsApplyState } from "../config/update.js";
import type { GuardSettings } from "../shared/types.js";
import { type AuditEntry } from "./monitor.js";
export interface TaskCase {
    id: string;
    plugin: string;
    kind: string;
    operation: string;
    target: string;
    ruleId?: string;
    currentRuleId?: string;
    action: "deny" | "restart";
    currentAction: "audit" | "deny" | "restart";
    count: number;
    lastAt: number;
    entry: AuditEntry;
    uncertain: boolean;
    acknowledged: boolean;
}
export interface TaskCoverage {
    complete: false;
    truncated: boolean;
    recordsRead: number;
    sampled: number;
    matched: number;
    windowStart?: number;
    windowEnd?: number;
    lossReported: boolean;
    errors: string[];
}
export interface TaskCases {
    revision: string;
    cases: TaskCase[];
    coverage: TaskCoverage;
}
/** 同插件、行为、目标与规则才会合并；配置上下文变化后重新提示。 */
export declare function readTaskCases(stateDir: string, settings: GuardSettings, options?: {
    includeAcknowledged?: boolean;
    plugin?: string;
}): TaskCases;
/** 核对只改变待办状态；条件失效时拒绝确认旧卡片。 */
export declare function acknowledgeTaskCases(stateDir: string, settings: GuardSettings, ids: string[]): TaskCases | undefined;
export interface PluginFinding {
    kind: "blocked" | "configuration" | "startup" | "unknown";
    title: string;
    detail: string;
    scope: "plugin" | "global";
    action: "review-cases" | "retry-apply" | "wait" | "restart-host" | "inspect-startup" | "view-logs";
    caseIds?: string[];
    evidence?: AuditEntry[];
}
/** 只列已有证据；全局错误不归因为某个插件。 */
export declare function diagnosePlugin(stateDir: string, settings: GuardSettings, plugin: string, apply?: SettingsApplyState, status?: Record<string, unknown>): {
    plugin: string;
    revision: string;
    findings: PluginFinding[];
    cases: TaskCase[];
    coverage: TaskCoverage;
};
