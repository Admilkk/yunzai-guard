import type { GuardSettings } from "../shared/types.js";
export interface SettingsApplyState {
    status: "applied" | "applying" | "pending-restart" | "failed";
    mode: "live" | "worker-reload" | "host-restart";
    revision: number;
    liveFields: string[];
    reloadFields: string[];
    restartFields: string[];
    error?: string;
}
export interface SettingsUpdatePlan {
    live: GuardSettings;
    candidate: GuardSettings;
    liveFields: string[];
    reloadFields: string[];
    restartFields: string[];
}
/** 比较新旧配置，拆分为直接生效、重建业务进程与重启宿主三类字段。 */
export declare function planSettingsUpdate(active: GuardSettings, next: GuardSettings): SettingsUpdatePlan;
