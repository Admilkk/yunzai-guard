import { type ChildProcess } from "node:child_process";
import { type CanonicalStats, type TransportCounters } from "./windows/diagnostics.js";
export { createCanonicalObserver as createWindowsCanonicalObserver, createTransportCounters as createWindowsSandboxTransportCounters, type CanonicalSnapshot as WindowsCanonicalSnapshot, type CanonicalStats as WindowsCanonicalStats, type TransportCounters as WindowsSandboxTransportCounters, } from "./windows/diagnostics.js";
export { writeControl as writeWindowsSandboxControl, forwardOutput as forwardWindowsSandboxOutput, disposeProcess as disposeWindowsSandboxProcess, } from "./windows/transport.js";
export interface WindowsSandboxSettings {
    shutdownTimeout?: number;
    sandbox?: {
        network: "none" | "host";
        writablePaths?: string[];
        writableFiles?: string[];
    };
}
export interface WindowsSandboxLaunch {
    executable: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    runtimeManifest?: string;
    cwd?: string;
    forwardOutput?: boolean;
    /** 插件会话独立的归属日志；省略时沿用项目单实例日志。 */
    sessionKey?: string;
    /** 协调原 data/config/temp 精确目录授权的内部元数据。 */
    sharedWritablePaths?: string[];
    /** 已接受的来源摘要，复制到会话后须再次核验。 */
    expectedExecutableSha256?: string;
    /** 按名称启动 node 子进程时仅使用当前会话运行时。 */
    prependRuntimePath?: boolean;
    /** 需从可读项目树中隐藏的可信宿主目录。 */
    additionalDeniedPaths?: string[];
    /** 可信的已验证运行时能力，或显式自编原生验证。 */
    canonicalMetadataProtocol?: 1;
}
export interface WindowsSandboxProcess extends ChildProcess {
    sandboxPid?: number;
    sandboxClientId?: number;
    sandboxSession: string;
    sandboxCleanup: Promise<void>;
    sandboxDispose: () => Promise<void>;
    runtimeSend: (clientId: number, message: unknown) => void;
    runtimeClose: (clientId: number) => void;
    sandboxTransportStats: () => TransportCounters;
    sandboxCanonicalStats: () => CanonicalStats;
}
export declare const windowsSandboxSourceNames: readonly string[];
/** 按私有构建缓存的相同顺序计算摘要，不编译或修改权限。 */
export declare function windowsSandboxBuildDigest(repository: string): string;
/** 校验预编译的 Windows 沙箱辅助程序并返回其路径。 */
export declare function compileWindowsSandbox(): string;
/** 仅重放当前 broker 会话创建的所有者私有日志，不清理其他会话。 */
export declare function cleanupWindowsSandbox(helper: string, session: string): Promise<void>;
/** ChildProcess 指原生 broker；sandboxPid 是 broker 核验的实际 Yunzai PID。 */
export declare function spawnWindowsSandbox(projectRoot: string, settings: WindowsSandboxSettings, options: WindowsSandboxLaunch): WindowsSandboxProcess;
