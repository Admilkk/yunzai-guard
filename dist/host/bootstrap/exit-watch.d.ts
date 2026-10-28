export interface BootstrapProcessIdentity {
    readonly pid: number;
    /** Linux 启动时钟计数或 Windows StartTime 的 UTC 计数；绝不只凭 PID 识别。 */
    readonly created: string;
    readonly parentPid: number;
    readonly namespace?: string;
}
export interface BootstrapExitWatch {
    readonly identities: readonly BootstrapProcessIdentity[];
    /** 仅在两个原始进程及本次观察器全部退出后完成。 */
    readonly exited: Promise<void>;
    /** 仅取消观察，不向任何被观察进程发送信号。 */
    close(): Promise<void>;
}
export declare class BootstrapExitWatchClosedError extends Error {
    /** 创建观察被关闭时的错误。 */
    constructor();
}
/** 交接就绪前捕获存活原始进程的身份，全程不向目标发送信号。 */
export declare function watchBootstrapExit(bootstrapPid: number, ownedRedisPid: number | null, timeout: number): Promise<BootstrapExitWatch>;
