import type { Pm2BootstrapExitGate } from "./bootstrap-exit.js";
import type { Pm2Process, Pm2God } from "./types.js";
export type { Pm2Environment, Pm2Process, Pm2God } from "./types.js";
export interface Pm2CompatibilityReport {
    event: "pm2-exit-barrier-wait" | "pm2-exit-barrier-complete" | "pm2-exit-barrier-failed" | "pm2-stale-exit-dropped";
    pmId?: string | number;
    pid?: number;
    reason?: string;
}
export interface Pm2CompatibilityOptions {
    launcherPath: string;
    report?: (event: Pm2CompatibilityReport) => void;
}
/** 捕获兼容层记录，返回恢复函数。 */
export declare function capturePm2Compatibility(god: Pm2God): () => void;
/** 可以包装已知旧方法；实际关卡仅由新安装的辅助状态绑定。 */
export declare function assertPm2BootstrapExitSupport(god: Pm2God): void;
/** 把首次接管的退出门控绑定到 PM2 子进程。 */
export declare function bindPm2BootstrapExit(god: Pm2God, child: Pm2Process, gate: Pm2BootstrapExitGate): void;
/** PM2 修改元数据前，先绑定刚验证的启动器代次。 */
export declare function recognizePm2Child(god: Pm2God, child: Pm2Process): void;
/** 调用方提交相关守护进程状态前必须完成验证。 */
export declare function preflightPm2Compatibility(god: Pm2God, launcherPath: string): void;
/**
 * PM2 6.0.14 的内核存活检查与 ChildProcess 退出处理相互独立。
 * 仅对明确选定的启动器，在这两项观察之间设置关卡。
 * 关卡失败时不完成 PM2 的停止回调；其重启实现忽略停止错误，
 * 返回错误仍可能导致新宿主启动。
 */
export declare function installPm2Compatibility(god: Pm2God, options: Pm2CompatibilityOptions): void;
