import { type NativeBotEventValue } from "./bot-events-protocol.js";
type Listener = (...args: unknown[]) => unknown;
export interface NativeBotEventsEmitter {
    /** 实际底层 Bot 事件发射器，全部会话必须使用同一对象身份。 */
    key: object;
    /** 可信且已绑定的方法，不能从插件输入解析方法。 */
    on(event: string, listener: Listener): unknown;
    off(event: string, listener: Listener): unknown;
    eventNames(): (string | symbol)[];
    listeners(event: string | symbol): Function[];
}
export interface NativeBotEventsFailure {
    kind: "delivery" | "cleanup";
    id: string;
    event: string;
    error: unknown;
}
export interface NativeBotEventsHostOptions {
    emitter: NativeBotEventsEmitter;
    sessionId?: string;
    /** 执行当前 native.bot.on/事件名规则，返回 false 或抛错即拒绝注册。 */
    policy(event: string): boolean | void;
    /** originalEvent 留在宿主，仅用于绑定请求能力和 ALS。 */
    invoke(id: string, args: NativeBotEventValue[], originalEvent?: Record<string, unknown>): Promise<unknown>;
    serializeArgs?(args: unknown[], event: string): NativeBotEventValue[];
    /** 清理失败时，集成方必须终止并回收原生会话。 */
    onFailure(failure: NativeBotEventsFailure): void;
}
export declare class NativeBotEventsCleanupError extends AggregateError {
    readonly code = "BOT_EVENT_CLEANUP_UNCONFIRMED";
}
/** 每个宿主闭包只属于一个会话，调用方不能选择其他会话或核心监听器。 */
export declare class NativeBotEventsHost {
    private readonly options;
    readonly sessionId: string;
    private readonly subscriptions;
    private readonly allOwned;
    private sequence;
    private pendingDeliveries;
    private readonly pendingOnce;
    private readonly retiredOnce;
    private closed;
    private reporting;
    /** 创建工作进程侧的 Bot 事件监听代理。 */
    constructor(options: NativeBotEventsHostOptions);
    /** 监听与投递统计。 */
    get stats(): Readonly<{
        listeners: number;
        pendingDeliveries: number;
        retiredOnce: number;
        closed: boolean;
    }>;
    /** 确认代理未被释放。 */
    private active;
    /** 上报监听投递失败。 */
    private report;
    /** 返回核心上该事件的监听列表。 */
    private listeners;
    /** 统计本代理登记的监听总数。 */
    private totalListeners;
    /** 从核心移除一个代理监听。 */
    private remove;
    /** 移除事件或全部代理监听。 */
    private clear;
    /** 把事件投递给沙箱中的监听。 */
    private deliver;
    /** 仅分发当前实例原生会话的已认证帧。 */
    receive(input: unknown): void;
    /** 失败条目保留在双方账本中，供重试和强制回收报告使用。 */
    close(): void;
}
export {};
