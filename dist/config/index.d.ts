import type { GuardSettings } from "../shared/types.js";
/** 只复制已校验配置；不在业务运行后重新依赖可变的解析入口。 */
export declare function snapshotSettings(settings: GuardSettings): GuardSettings;
/** 解析并验证 JSON 配置；未知属性直接拒绝，不求值表达式。 */
export declare function parseSettings(value: unknown): GuardSettings;
/** 此文件由宿主管理；调用方应向 worker 传递已验证快照。 */
export declare function loadSettings(stateDir: string): GuardSettings;
