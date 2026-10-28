import { type ExitHookSource } from "./exit-hooks.js";
export interface BootstrapExitPlan {
    /** 退出时仅允许向捕获的原始 ChildProcess 发送信号。 */
    readonly redisPid: number | null;
    prepare(timeout: number): Promise<void>;
    assertCurrent(): void;
}
/** 原回调仍可能执行时，仅准备持久化，不提前关闭资源。 */
export declare function createBootstrapExitPlan(bot: ExitHookSource, redisClient: unknown, currentClient: () => unknown): BootstrapExitPlan;
