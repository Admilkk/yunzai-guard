import type { EmitEvent, GuardSettings } from "../shared/types.js";
import type { HookWatch } from "./watch.js";
export type CoverageState = "disabled" | "pending" | "protected" | "changed" | "inspection-failed";
export interface TargetCoverage {
    state: CoverageState;
    reason?: "missing" | "inspection-failed";
}
type Roots = Record<string, unknown> | (() => Record<string, unknown>);
/** 定期检查对象身份和描述符以检测篡改，不构成 VM 安全边界。 */
export declare class IntegrityMonitor {
    #private;
    /** 创建关键函数完整性监控。 */
    constructor(settings: GuardSettings, roots: Roots, emit: EmitEvent, watch?: HookWatch);
    /** 每个目标只在首次出现时捕获一次，已有基线不再刷新。 */
    capture(): void;
    /** 覆盖率由运行时自报，不能独立证明可抵御同进程恶意代码。 */
    coverage(): {
        enabled: boolean;
        targets: (TargetCoverage & {
            target: string;
        })[];
    };
    /** 检查全部目标，变化时按配置上报一次。 */
    check(): void;
    /** 启动定期检查。 */
    start(): void;
    /** 停止定期检查。 */
    stop(): void;
}
export {};
