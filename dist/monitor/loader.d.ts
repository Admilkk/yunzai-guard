import type { GuardSettings } from "../shared/types.js";
/** 已适配的核心及其加载器桥接点；未识别的核心按 TRSS 处理，标记不符时降级。 */
export interface CoreProfile {
    id: "trss" | "jiuli";
    /** 实际实现 PluginsLoader 的文件，相对 Yunzai 根目录。 */
    loaderFile: string;
    /** 每条消息创建插件实例的原始表达式。 */
    construction: string;
    /** 改写为桥接构造时的参数：构造器、参数数组、插件名。 */
    constructArgs: string;
    /** 是否已适配独立插件沙箱所需的规则与上下文桥接。 */
    nativeSandbox: boolean;
}
export declare const coreProfiles: Readonly<Record<CoreProfile["id"], Readonly<CoreProfile>>>;
/** 依据根目录 package.json 名称及加载器文件识别核心，读取失败时按 TRSS 处理。 */
export declare function detectCoreProfile(root: string): Readonly<CoreProfile>;
/** 可选观察允许降级，但明确选择的强制保护不能静默失效。 */
export declare function requiresCoreLoaderBridge(settings: GuardSettings): boolean;
/** 仅在内存中改写已识别的导出或调用点，不猜测陌生加载器的结构。 */
export declare function instrumentCoreLoaderSource(source: string, nativeEnabled: boolean, profile?: Readonly<CoreProfile>): string | undefined;
