import type { ChildProcess } from "node:child_process";
export interface LinuxSandboxSettings {
    sandbox?: {
        network: "none" | "host";
        writablePaths: string[];
        writableFiles?: string[];
        /** 原生插件 IPC 使用继承的 FD3，无需向外 connect/send。 */
        denyNetworkCalls?: boolean;
        bwrapPath?: string;
    };
}
export interface LinuxSandboxLaunch {
    executable: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    runtimeManifest: string;
}
export interface LinuxSandboxSpec {
    executable: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
    extraStdio: Array<{
        fd: number;
        source: number;
    }>;
    pidNamespace: true;
    statusFd: 5;
    network: "none" | "host";
    dispose: () => void;
    observe: (child: ChildProcess) => void;
    waitForExit: (child: ChildProcess, timeoutMs?: number) => Promise<void>;
}
/** 在命名空间之上增加少量拒绝规则，不提供通用系统调用白名单。 */
export declare function linuxSeccompFilter(architecture?: NodeJS.Architecture, denyNetworkCalls?: boolean): Buffer;
/**
 * FD 3 保留私有 Node IPC，FD 4 传递只读 seccomp 程序。
 * spawn 后必须调用 dispose() 关闭父进程 FD，错误路径也不例外。
 */
export declare function buildLinuxSandbox(projectRoot: string, settings: LinuxSandboxSettings, launch: LinuxSandboxLaunch): LinuxSandboxSpec;
