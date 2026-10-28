import { type ChildProcess } from "node:child_process";
export interface PlatformCapabilities {
    platform: string;
    supported: boolean;
    isolation: "managed-process" | "os-sandbox";
    osSandbox: boolean;
    processTree: "process-group" | "identity-checked-snapshot" | "pid-namespace" | "job-object" | "unsupported";
    limitations: string[];
}
/** 返回当前平台支持的运行模式与隔离能力。 */
export declare function capabilities(platform?: NodeJS.Platform, mode?: string): PlatformCapabilities;
/** 确认当前平台支持所选运行模式。 */
export declare function assertPlatform(mode: string, platform?: NodeJS.Platform): void;
/** 执行 PowerShell 脚本并返回标准输出。 */
export declare function powershell(script: string, timeout?: number): Promise<string>;
/** 等待首次接管前的原进程及其子进程退出。 */
export declare function waitForBootstrapExit(pid: number, timeout: number): Promise<void>;
export interface ProcessIdentity {
    pid: number;
    created: string;
}
/** spawn 后首次 await 前，同步固定原始原生接收器。 */
export declare function prepareDescendantCapture(child: ChildProcess): void;
/** PID 和创建时间仅作证据，不能据此重新打开进程并终止。 */
export declare function captureDescendants(child: ChildProcess, remainingBudgetMs?: number): Promise<ProcessIdentity[]>;
/** native0 可能重置 libuv 记录的退出信号，终止前必须停止后代捕获。 */
export declare function retireDescendantCapture(child: ChildProcess): void;
/** 判断子进程是否已退出。 */
export declare function hasExited(child: ChildProcess): boolean;
/** 仅处理本宿主创建的子进程，不接受任意外部 PID。 */
export declare function terminateWorkerTree(child: ChildProcess, descendants: ProcessIdentity[], options?: {
    ownedOsScope?: boolean;
}): Promise<void>;
