import type { ChildProcess } from "node:child_process";
import type { BootstrapExitWatch } from "../host/bootstrap/exit-watch.js";
export interface Pm2BootstrapExitGate {
    readonly exited: Promise<void>;
    readonly released: boolean;
    fail(reason: string): void;
}
/** 冷启动代次持有此记录，直到提交及系统进程退出均已确认。 */
export declare class Pm2BootstrapExit implements Pm2BootstrapExitGate {
    private child;
    private nonce;
    private watch;
    private valid;
    private onFailure;
    readonly exited: Promise<void>;
    released: boolean;
    private committed;
    private rootExited;
    private resourcesExited;
    private failure?;
    private settling;
    private resolve;
    private reject;
    private timer;
    private closing?;
    /** 是否已失败。 */
    get failed(): boolean;
    /** 创建首次接管的原进程退出门控。 */
    constructor(child: ChildProcess, nonce: string, watch: BootstrapExitWatch, timeout: number, valid: () => boolean, onFailure: (reason: string) => void);
    /** 处理原进程的退出准备消息。 */
    private onMessage;
    /** 原进程退出时检查是否成功。 */
    private onExit;
    /** 关闭退出观察，只执行一次。 */
    private closeWatch;
    /** 清理定时器与监听器。 */
    private cleanup;
    /** 条件满足时放行或判定失败。 */
    private check;
    /** 以原因标记失败并清理。 */
    fail(reason: string): void;
}
