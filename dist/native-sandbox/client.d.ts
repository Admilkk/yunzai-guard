import type { EmitEvent, GuardSettings } from "../shared/types.js";
import type { NativeSandboxPlugin, NativeLoadResult } from "./types.js";
export { snapshotEvent } from "./event-snapshot.js";
type Row = Record<string, unknown>;
type Event = Row & {
    reply?: (...args: unknown[]) => unknown;
};
export interface NativeRequestCapabilities {
    handlerReject?: (message: string) => unknown;
}
export declare class NativePluginClient {
    #private;
    readonly root: string;
    private readonly emit;
    private readonly redis;
    private readonly onFailure?;
    private readonly onCoreRestart?;
    readonly config: NativeSandboxPlugin;
    private session?;
    private readonly pending;
    private readonly events;
    private readonly capabilities;
    private readonly serviceIds;
    private lastServiceId;
    private readyPromise?;
    private closed;
    private retiring;
    private failed?;
    private fatalHook;
    private loadQueue;
    private closePromise?;
    private errorLogs;
    private launchPromise?;
    private applicationReady;
    private handshakeReceived;
    private transportReceived;
    private readonly ingress;
    private adapterHost?;
    private botEventsHost?;
    private readonly media;
    private readonly mediaSource;
    readonly pluginRoot: string;
    /** 创建原生插件沙箱客户端。 */
    constructor(root: string, config: NativeSandboxPlugin, settings: GuardSettings, emit: EmitEvent, redis: () => unknown, onFailure?: ((error: Error) => Promise<void>) | undefined, onCoreRestart?: (() => void) | undefined);
    /** 按规则检查沙箱请求的操作。 */
    private policy;
    /** 以错误停止会话并拒绝在途请求。 */
    private stop;
    /** 启动沙箱子进程并等待就绪。 */
    ready(): Promise<void>;
    /** 向沙箱发送一帧。 */
    private send;
    /** 处理沙箱发来的帧。 */
    private receive;
    /** 检查入站帧的速率与配额。 */
    private checkIngress;
    /** 消耗一次任务配额。 */
    consumeTask(): void;
    /** 执行沙箱请求的宿主能力。 */
    private service;
    /** 有界传输仅允许一次固定延期，分片不能使请求无限存活。 */
    private extendMediaRequest;
    /** 向沙箱发起请求并等待结果。 */
    request(type: string, values: Row, event?: Event, capabilities?: NativeRequestCapabilities): Promise<unknown>;
    /** 释放沙箱中的实例。 */
    releaseInstances(instances: Array<{
        classId: string;
        instanceId: string;
    }>): Promise<void>;
    /** 在沙箱中加载插件入口。 */
    load(entry: string): Promise<NativeLoadResult>;
    /** 建立 Bot 事件代理。 */
    private initializeBotEvents;
    /** 收集不能交给沙箱的受保护 Bot 对象。 */
    private protectedBotObjects;
    /** 关闭会话并结束子进程。 */
    close(): Promise<void>;
}
