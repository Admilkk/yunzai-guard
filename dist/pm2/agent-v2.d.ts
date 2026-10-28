import type { Pm2ApplicationOptions, Pm2ApplicationRegistration, Pm2DaemonGod, Pm2DaemonContext } from "./types.js";
export type * from "./types.js";
export { resolveCachedGod } from "./god-context.js";
export { preparePm2InspectorClose, preparePm2InspectorCloseWithGod, } from "./inspector-session-v1.js";
export declare const pm2AgentCapabilities: Readonly<{
    agentProtocol: 2;
    bootstrapExitBarrier: 1;
    cachedRegistryUpgrade: 1;
}>;
/** 纯守护进程状态入口；公开入口还会验证实际 Node 角色。 */
export declare function registerPm2ApplicationWithGod(god: Pm2DaemonGod, options: Pm2ApplicationOptions, context: Pm2DaemonContext): Promise<Pm2ApplicationRegistration>;
/** 仅在客户端通过 Inspector 识别自己的父守护进程后调用。 */
export declare function registerPm2Application(options: Pm2ApplicationOptions): Promise<Pm2ApplicationRegistration>;
