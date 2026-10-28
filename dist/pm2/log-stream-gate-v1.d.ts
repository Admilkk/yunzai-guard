import { ChildProcess } from "node:child_process";
export interface Pm2LoggingUtility {
    startLogging: (this: unknown, streams: Record<string, unknown>, ...args: unknown[]) => unknown;
}
export interface Pm2LogDrainResult {
    status: "drained" | "not-drained";
    reason?: string;
    fatal?: true;
}
export interface Pm2LogGate {
    settled: Promise<Pm2LogDrainResult>;
    result?: Pm2LogDrainResult;
}
interface CaptureOptions {
    utility?: Pm2LoggingUtility;
    expectedPaths: Record<string, unknown>;
    timeout: number;
    report?: (event: {
        event: string;
        pid?: number;
        reason?: string;
    }) => void;
}
/** 返回子进程的日志门控。 */
export declare function pm2LogGateFor(child: object): Pm2LogGate | undefined;
/** 在 PM2 现有三倍 kill_timeout 失败预算内预留余量。 */
export declare function pm2LogDrainTimeout(killTimeout: unknown): number;
/**
 * 只捕获属于下一次 fork 的同步、精确 Utility 调用。
 * 回调可能同步执行，因此必须在调用 run() 前建立捕获。
 * 这只是有限的日志诊断，不是授权资源退出的关卡。
 */
export declare function createPm2ForkLogCapture(options: CaptureOptions): {
    run<T>(invoke: () => T): T;
    bind(child: ChildProcess): Pm2LogGate;
};
export {};
