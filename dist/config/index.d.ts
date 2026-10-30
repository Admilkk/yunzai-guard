import type { GuardSettings } from "../shared/types.js";
/** 只复制已校验配置；不在业务运行后重新依赖可变的解析入口。 */
export declare function snapshotSettings(settings: GuardSettings): GuardSettings;
/** 解析并验证 JSON 配置；未知属性直接拒绝，不求值表达式。 */
export declare function parseSettings(value: unknown): GuardSettings;
/** 当前版本的默认配置，序列化为普通对象。 */
export declare function settingsDefaults(): Record<string, unknown>;
/** 宿主启动时整理配置文件，见 prepareSettingsFiles；返回需要提示用户的信息。 */
export declare function prepareSettings(stateDir: string): string[];
/**
 * 读取并校验配置：优先 settings.yaml，只有旧版 settings.json 时直接读取它。
 * 此文件由宿主管理；调用方应向 worker 传递已验证快照。
 */
export declare function loadSettings(stateDir: string): GuardSettings;
