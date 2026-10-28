import type { GuardSettings, EmitEvent } from "../shared/types.js";
type Row = Record<string, any>;
/** 在原加载器导入选中插件源码前，先确定原生进程执行路径。 */
export declare class NativePluginLoader {
    private readonly root;
    private readonly settings;
    private readonly emit;
    private readonly restart?;
    private readonly clients;
    private readonly loadedFiles;
    private readonly failedPlugins;
    private readonly matchers;
    private readonly ruleCalls;
    private readonly ruleMarkers;
    private readonly messageScope;
    private readonly closedScopes;
    private readonly registrations;
    private loader?;
    private originalUnload?;
    /** 创建原生插件加载器。 */
    constructor(root: string, settings: GuardSettings, emit: EmitEvent, restart?: (() => void) | undefined);
    /** 返回插件的沙箱配置。 */
    private configuration;
    /** 取得或创建插件的沙箱客户端。 */
    private client;
    /** 退役插件的沙箱会话。 */
    private retire;
    /** 在沙箱中测试规则。 */
    testRule(regexp: RegExp, text: string): Promise<boolean>;
    /** 生成规则方法的调用参数。 */
    ruleArgs(fn: Function | undefined, regexp: RegExp, event: Row): unknown[];
    /** 释放消息处理期间创建的实例。 */
    private releaseInstances;
    /** 为沙箱插件类生成核心可用的构造器代理。 */
    private constructorProxy;
    /** 接入核心加载器，把沙箱插件交给核心加载。 */
    attach(loader: Row): void;
    /** 关闭全部沙箱会话。 */
    close(): Promise<void>;
}
export {};
