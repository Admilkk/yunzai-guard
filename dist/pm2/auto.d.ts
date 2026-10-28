import { type InspectorDeadline } from "./inspector.js";
export interface Pm2AutoOptions {
    root: string;
    launcherPath: string;
    shutdownTimeout: number;
    startupTimeout: number;
    requestRestart: boolean;
    bootstrapRedisPid?: number | null;
}
export interface Pm2AutoRegistration {
    status: "registered";
    daemonPid: number;
    pmId: number;
    pid: number;
    launcherPath: string;
    requiresHandoff: boolean;
    nonce?: string;
    bootstrapExitBarrier?: 1;
}
/** 判断当前进程是否由 PM2 启动。 */
export declare function hasPm2Environment(env?: NodeJS.ProcessEnv): boolean;
/** 解析 PM2 应用编号。 */
export declare function pm2ApplicationId(value: string | undefined): number;
/** 校验 daemon 返回的登记结果。 */
export declare function assertPm2Registration(value: unknown, expected: {
    pid: number;
    pmId: number;
    daemonPid: number;
    launcherPath: string;
    requestRestart: boolean;
}): asserts value is Pm2AutoRegistration;
/** 经 PM2 IPC 请求关闭 Inspector。 */
export declare function closePm2InspectorOverIpc(expected: {
    nonce: string;
    url: string;
    pmId: number;
    daemonPid: number;
}, deadline?: InspectorDeadline): Promise<void>;
/**
 * 仅通过已验证的当前父进程联系既有守护进程。
 * 宿主独占的共享截止时间覆盖登记及后续交接；
 * 它不序列化到守护进程请求中，也不在登记后重置。
 */
export declare function registerCurrentPm2Application(options: Pm2AutoOptions, sharedDeadline?: InspectorDeadline): Promise<Pm2AutoRegistration | null>;
