import type { AdapterMethodCall } from "./adapter-protocol.js";
import { type Channel } from "./protocol.js";
export { ProtocolError as NativeGuestError, maxFrameBytes as maxNativeFrameBytes, toDto, fromDto, type Dto, type Channel as GuestChannel, } from "./protocol.js";
export declare class NativeGuest {
    private readonly channel;
    private readonly calls;
    private readonly classes;
    private readonly contexts;
    private root?;
    private pluginRoot?;
    private initializePromise?;
    private base?;
    private cleanupSymbol?;
    private callbackCount;
    private hookAction;
    private adaptersEnabled;
    private adapter?;
    private botEvents?;
    private botEventsSessionId?;
    private readonly media;
    private readonly mediaSource;
    private readonly botIds;
    private jiuli;
    private instanceCount;
    /** 创建沙箱内的插件运行端。 */
    constructor(channel: Channel);
    /** 等待宿主处理回复。 */
    private reply;
    /** 更新沙箱内的 Bot 快照。 */
    updateBotSnapshot(input: unknown): void;
    /** 对沙箱不支持的接口抛错。 */
    private unsupported;
    /** 创建冻结的隔离 API 对象。 */
    private isolatedApi;
    /** 初始化核心 API 副本与模块解析。 */
    private initialize;
    /** 提取插件实例的元数据。 */
    private metadata;
    /** 规范化插件声明的处理器。 */
    private handlers;
    /** 编译规则正则。 */
    private rulePattern;
    /** 判断规则方法是否缺失。 */
    private missingRule;
    /** 为规则取得可调用方法。 */
    private ruleMethod;
    /** 为缺失的规则方法分配占位名。 */
    private allocateMissingRuleMethod;
    /** 列出插件实例的可调用方法。 */
    private methods;
    /** 绑定实例上的事件对象。 */
    private bindEvent;
    /** 加载插件入口并登记导出的插件类。 */
    load(requestId: string, rootInput: string, pluginInput: string, entryInput: string, hookAction?: "audit" | "deny" | "restart", adapters?: boolean, eventsSessionId?: string): Promise<unknown>;
    /** 调用插件实例方法。 */
    call(requestId: string, classId: string, method: string, eventInput?: unknown, argsInput?: unknown[], eventArgsInput?: unknown[], handlerReject?: boolean, contextHandle?: string, instanceId?: string, ruleIndex?: number): Promise<unknown>;
    /** 释放插件实例。 */
    releaseInstance(classId: string, instanceId: string): void;
    /** 调用插件的上下文处理方法。 */
    context(requestId: string, classId: string, eventInput: unknown, isGroup: boolean): Promise<unknown>;
    /** 判断文本是否匹配插件规则。 */
    match(classId: string, ruleIndex: number, text: string): boolean;
    /** 取得缓存的规则正则。 */
    private pattern;
    /** 执行插件登记的回调。 */
    callback(requestId: string, classId: string, handle: string, eventInput?: unknown, argsInput?: unknown[], eventArgsInput?: unknown[], handlerReject?: boolean): Promise<unknown>;
    /** 执行适配器方法调用。 */
    adapterCall(requestId: string, call: AdapterMethodCall): Promise<unknown>;
    /** 执行 Bot 事件监听回调。 */
    botEvent(requestId: string, handle: string, args: unknown[], eventReply: boolean): Promise<null>;
    /** 仅对明确注册到原核心基类的资源执行正常清理。 */
    dispose(requestId: string): Promise<unknown>;
}
