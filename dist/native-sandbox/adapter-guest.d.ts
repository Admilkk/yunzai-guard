import { type AdapterFrame, type AdapterId, type AdapterMethodCall, type AdapterRegistration, type AdapterValue } from "./adapter-protocol.js";
type Row = Record<string, unknown>;
/** 原 SDK 对象和函数留在此处，集成方只提供值帧发送器。 */
export declare class NativeAdapterGuest {
    private readonly send;
    readonly adapter: Row[];
    readonly connectedIds: AdapterId[];
    private readonly registrations;
    private readonly registeredObjects;
    private readonly accounts;
    private readonly bindings;
    private retiring;
    private closed;
    private disposal?;
    /** 创建沙箱内的适配器代理。 */
    constructor(send: (frame: AdapterFrame) => void);
    /** 确认代理未被释放。 */
    private active;
    /** 向宿主发布适配器帧。 */
    private publish;
    /** 登记一个能力绑定，返回句柄。 */
    private bind;
    /** 登记插件提供的适配器及其账号。 */
    register(value: unknown): AdapterRegistration;
    /** 仅由插件 Bot 属性的账号赋值分支调用，宿主代码不调用。 */
    setAccount(id: unknown, value: unknown): void;
    /** 按 id 取得账号；撤销外部能力期间，原 logout 仍可能经 Bot[id] 使用自身 SDK。 */
    getAccount(id: unknown): unknown;
    /** 判断账号是否存在。 */
    hasAccount(id: unknown): boolean;
    /** 移除账号并撤销其能力。 */
    removeAccount(id: unknown): void;
    /** 为账号或实体方法登记句柄。 */
    private method;
    /** 生成账号的可序列化快照。 */
    private snapshot;
    /** 把账号变化同步给宿主。 */
    flush(): void;
    /** Bot.em 保持同步；按序先发布账号元数据，再发布事件。 */
    emit(name: string, input: unknown): void;
    /** 按选择器取得账号或成员对象。 */
    private select;
    /** 执行宿主转来的适配器方法调用。 */
    invoke(input: AdapterMethodCall, restoreArgs?: (args: AdapterValue[]) => Promise<unknown[]>): Promise<AdapterValue>;
    /** 注销全部账号并释放代理。 */
    dispose(): Promise<{
        accounts: number;
        logoutFailures: number;
    }>;
}
export {};
