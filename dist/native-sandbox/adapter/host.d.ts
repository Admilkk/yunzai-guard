import { type AdapterMethodCall, type AdapterValue } from "./protocol.js";
type Row = Record<string, unknown>;
export interface NativeAdapterHostOptions {
    pluginId: string;
    bot: Row;
    invoke(call: AdapterMethodCall): Promise<unknown>;
    /** 可选的纯字节转换，不解析插件提供的路径或 URL。 */
    serializeArgs?(args: unknown[]): AdapterValue[];
    discardArgs?(args: AdapterValue[]): void;
}
/**
 * 调用方须明确授权本会话作为可信适配器消息来源。
 * 本端自行构建全部宿主函数，不接收插件函数或 SDK。
 */
export declare class NativeAdapterHost {
    private readonly options;
    private readonly session;
    private readonly owners;
    private readonly adapters;
    private readonly accounts;
    private readonly pending;
    private readonly adapterArray;
    private readonly uin;
    private readonly emitCore;
    private readonly protectedIds;
    private closed;
    /** 创建工作进程侧的适配器代理。 */
    constructor(options: NativeAdapterHostOptions);
    /** 确认代理未被释放。 */
    private active;
    /** 向沙箱发起适配器方法调用。 */
    private call;
    /** 把条目列表转为按 id 索引的 Map。 */
    private map;
    /** 把成员条目转为两级 Map。 */
    private memberMap;
    /** 读取缓存的条目，不存在时抛错。 */
    private cached;
    /** 按选择器取得缓存的资料。 */
    private pick;
    /** 为账号创建对核心可见的外观对象。 */
    private accountFacade;
    /** 根据沙箱快照刷新账号外观。 */
    private refresh;
    /** 只路由来自本组件已认证原生会话的帧。 */
    receive(input: unknown): void;
    /** 从核心移除账号。 */
    private remove;
    /** 立即撤销能力；系统回收前，由调用方另行请求插件清理。 */
    close(): void;
}
export {};
