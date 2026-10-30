type Row = Record<string, any>;
/** 环绕钩子：this 为原调用者，next 以给定参数继续调用内层并返回其结果。 */
export type LoaderHook<A extends unknown[] = any[]> = (this: Row, next: (...args: any[]) => any, ...args: A) => unknown;
/**
 * 核心 PluginsLoader 的钩子引擎：每个方法只替换一次，各模块登记的环绕钩子按登记顺序由外到内执行。
 * 同步方法保持同步，返回值与 this 原样透传；同一加载器共用一个引擎。
 */
export declare class LoaderHooks {
    #private;
    readonly loader: Row;
    private constructor();
    /** 取得加载器的钩子引擎，首次调用时创建。 */
    static of(loader: Row): LoaderHooks;
    /** 登记环绕钩子；先登记的在外层。方法不存在时不登记并返回 false。 */
    around<A extends unknown[]>(method: string, hook: LoaderHook<A>): boolean;
    /** 未经任何钩子的原方法，供需要绕开外层逻辑的回滚路径使用。 */
    original(method: string): Function | undefined;
    /** 初始化时登记可信入口判断；导入时只按已登记的判断标记 Guard 自有插件。 */
    trustWhen(matches: (file: Row) => boolean): void;
    /** 全部运行时模块接入后关闭注册与原方法访问，业务插件加载期间不能再更改引擎。 */
    lock(): void;
    /** 是否为 Guard 自有的插件。 */
    trusted(key: unknown): boolean;
}
export {};
