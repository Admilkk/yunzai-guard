import type { EmitEvent, GuardSettings } from "../shared/types.js";
import type { HookWatch } from "./watch.js";
type Dynamic = Record<string, unknown>;
/** 仅由运行时闭包传入，不挂到公开 GuardContext。 */
interface PluginContext {
    settings: GuardSettings;
    run: <T>(name: string, callback: () => T) => T;
}
export interface PluginActivity {
    name: string;
    imports: number;
    loads: number;
    registered: number;
    calls: number;
    blocked: number;
    unwrapped: number;
}
export interface PluginSnapshot {
    entries: PluginActivity[];
    truncated: boolean;
}
/** 兼容性插桩只记录入口次数及归属，不构成恶意代码防护边界。 */
export declare class PluginMonitor {
    #private;
    /** 创建插件入口监控。 */
    constructor(context: PluginContext, emit: EmitEvent, check: () => void, watch?: HookWatch, currentPlugin?: () => string | undefined);
    /** 返回插件活动统计快照。 */
    snapshot(): PluginSnapshot;
    /** 让观察器比较受信插桩与其包装的原函数。 */
    originalFunction(value: Function): Function;
    /** 登记核心创建的插件实例并包装其方法。 */
    attachInstance(instance: Dynamic, name: string): void;
    /** Yunzai 为每条消息新建处理器实例，须保留原 new.target。 */
    construct(constructor: Function, args: unknown[], name: string): object;
    /** 经钩子引擎桥接加载器实例，不修改构造器或磁盘核心源码；Guard 自有插件原样放行。 */
    attach(loader: Dynamic): void;
}
export {};
