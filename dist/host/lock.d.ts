import net from "node:net";
export declare class ProjectLockError extends Error {
    code: string;
    /** 创建带错误码的宿主锁错误。 */
    constructor(code: string, message: string);
}
interface ControlIdentity {
    token: string;
    port: number;
    hostPid: number;
    projectId: string;
}
export interface ProjectLockDependencies {
    listen?: (endpoint: string | number, server?: net.Server) => Promise<net.Server>;
    processAlive?: (pid: number) => Promise<boolean> | boolean;
    queryStatus?: (identity: ControlIdentity) => Promise<unknown>;
    portListening?: (port: number) => Promise<boolean>;
    portExcluded?: (port: number) => Promise<boolean>;
    nonListeningConnections?: (port: number) => Promise<boolean>;
}
export interface ProjectLock {
    kind: "named-pipe" | "tcp";
    endpoint: string | number;
    legacyPort: number;
    legacyPortExcluded: boolean;
    legacyBridgeUnavailable: boolean;
    legacyBridgeReason?: "excluded-port" | "non-listening-connections";
    servers: net.Server[];
    close(): Promise<void>;
}
/** 由项目标识推算旧版控制端口。 */
export declare function legacyProjectPort(projectId: string): number;
/** 由项目标识生成 Windows 命名管道路径。 */
export declare function windowsProjectPipe(projectId: string): string;
/** 仅解析 netsh 的数字范围行，忽略本地化标题。 */
export declare function excludedPortRanges(output: string): Array<[number, number]>;
/** 仅接受明确的 Bound 状态及已连接对端；监听状态和未知行均拒绝。 */
export declare function onlyNonListeningConnections(value: unknown): boolean;
/** 旧宿主状态未确认时，不删除或覆盖其凭据。 */
export declare function assertNoPreviousHost(controlPath: string, projectId: string, dependencies?: ProjectLockDependencies): Promise<"absent" | "stale">;
/** 新 Windows 宿主统一使用同一命名管道锁，与控制端口无关。 */
export declare function acquireProjectLock(options: {
    projectId: string;
    controlPath: string;
    platform?: NodeJS.Platform;
    legacyServer?: net.Server;
}, dependencies?: ProjectLockDependencies): Promise<ProjectLock>;
export {};
