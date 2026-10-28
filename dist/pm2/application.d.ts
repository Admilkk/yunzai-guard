import type { Pm2ApplicationOptions, Pm2DaemonContext, Pm2DaemonEnvironment } from "./types.js";
export interface ApplicationIdentity {
    pmId: number;
    uniqueId: string;
    root: string;
    appPath: string;
    launcherPath: string;
    shutdownTimeout: number;
    startupTimeout: number;
}
export declare const ticketKey = "YUNZAI_GUARD_PM2_TICKET";
/** 校验 PM2 应用登记选项与 daemon 上下文一致。 */
export declare function validateOptions(options: Pm2ApplicationOptions, context: Pm2DaemonContext): void;
/** 生成受管子进程使用的环境变量。 */
export declare function nestedEnvironment(environment: Pm2DaemonEnvironment): Record<string, unknown> | undefined;
/** 生成应用启动参数补丁。 */
export declare function createPatch(environment: Pm2DaemonEnvironment, app: ApplicationIdentity): Record<string, unknown>;
/** 把补丁写入 PM2 应用环境。 */
export declare function commitPatch(environment: Pm2DaemonEnvironment, patch: Record<string, unknown>): void;
/** 判断 PM2 应用环境是否为目标应用。 */
export declare function matchesApplication(environment: Pm2DaemonEnvironment, app: ApplicationIdentity): boolean;
