import type { TargetCoverage } from "./integrity.js";
import type { PluginSnapshot } from "./plugin.js";
export interface MonitorReport {
    targets: TargetCoverage[];
    plugins: PluginSnapshot;
}
/** 验证 worker 提示信息，仅将受限的公开字段复制到宿主状态。 */
export declare function parseMonitorReport(value: unknown, targetCount: number): MonitorReport;
/** 合并配置目标与工作进程报告，生成 status 中的监控状态。 */
export declare function monitorStatus(configuredTargets: readonly string[], snapshot?: {
    report: MonitorReport;
    receivedAt: number;
}, live?: boolean, now?: number): {
    source: string;
    freshness: string;
    receivedAt: number | undefined;
    targets: ({
        state: import("./integrity.js").CoverageState;
        reason?: "missing" | "inspection-failed";
        target: string;
    } | {
        state: string;
        target: string;
    })[];
    plugins: PluginSnapshot;
};
