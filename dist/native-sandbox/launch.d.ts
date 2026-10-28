import { type ChildProcess } from "node:child_process";
import { type WindowsCanonicalStats } from "../sandbox/windows.js";
import { type PrivateWindowsRuntimeSelection } from "../sandbox/windows-runtime.js";
export interface NativeSandboxOptions {
    root: string;
    pluginRoot: string;
    entry: string;
    args?: string[];
    network: "none" | "host";
    writablePaths?: string[];
    writableFiles?: string[];
    /** 与其他已启用且显式配置的插件共享的精确额外目录授权。 */
    sharedWritablePaths?: string[];
    behavior?: {
        pluginId: string;
        settings: unknown;
    };
    /** 显式选择的私有测试候选，默认仍使用原宿主 Node。 */
    privateWindowsRuntime?: PrivateWindowsRuntimeSelection;
}
export interface NativeSandboxSession {
    child: ChildProcess;
    platform: "linux" | "win32";
    pluginRoot: string;
    /** 等待传输握手前先挂接应用 IPC 监听器。 */
    ready: Promise<void>;
    /** 快照来自本会话原始原生 broker，元数据独立于审计。 */
    windowsCanonicalStats?: () => WindowsCanonicalStats;
    close(): Promise<void>;
}
export declare const nativeStartupTimeoutMs = 60000;
/** 判断启动失败后是否已确认清理完成。 */
export declare function nativeStartupCleanupConfirmed(error: unknown): boolean;
/** 子进程必须受系统限制，不提供无沙箱回退。 */
export declare function launchNativeSandbox(options: NativeSandboxOptions): Promise<NativeSandboxSession>;
