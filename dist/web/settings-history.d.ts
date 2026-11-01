import { type SettingsApplyState } from "../config/update.js";
import type { GuardSettings } from "../shared/types.js";
export interface SettingsChange {
    path: string;
    before?: unknown;
    after?: unknown;
}
export interface SettingsOperation {
    id: string;
    title: string;
    time: number;
    beforeRevision: string;
    revision: string;
    status: SettingsApplyState["status"] | "unknown";
    changes: SettingsChange[];
    canUndo: boolean;
    canRestoreBefore: boolean;
    canRestore: boolean;
}
/** 返回有限、脱敏的差异摘要；列表仅使用其中的路径。 */
export declare function settingsHistoryChanges(before: unknown, after: unknown): SettingsChange[];
/** 原值重试复用最近一次实际修改，保留原始撤销范围和操作信息。 */
export declare function reusableSettingsOperation(stateDir: string, revision: string): SettingsOperation | undefined;
/** 每次实际写入后登记；同一份原文只保留一个快照。 */
export declare function recordSettingsOperation(stateDir: string, options: {
    beforeText: string;
    afterText: string;
    backupId?: string;
    title?: string;
}): SettingsOperation | undefined;
/** 关联控制器真实代次；后续请求会使未确认完成的旧请求变成未知。 */
export declare function applySettingsOperation(stateDir: string, id: string, apply?: SettingsApplyState, currentRevision?: string): SettingsOperation | undefined;
/** 只确认与当前文件、实际活动配置及控制器代次一致的结果。 */
export declare function listSettingsOperations(stateDir: string, currentText: string, active: GuardSettings, apply?: SettingsApplyState): {
    operations: SettingsOperation[];
    lastAppliedId: string | undefined;
};
export declare function previewSettingsOperation(stateDir: string, id: string, target: "before" | "after", currentText: string, currentDocument: unknown, active: GuardSettings): {
    operation: SettingsOperation;
    target: "after" | "before";
    revision: string;
    document: {
        [x: string]: unknown;
    };
    raw: string;
    changes: SettingsChange[];
    plan: {
        liveFields: string[];
        reloadFields: string[];
        restartFields: string[];
    };
    hasLaterChanges: boolean;
    previewToken: string;
} | undefined;
export declare function settingsPreviewMatches(preview: NonNullable<ReturnType<typeof previewSettingsOperation>>, token: unknown): boolean;
