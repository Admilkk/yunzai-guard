import type { GuardAction, GuardEvent, GuardRule, GuardSettings } from "../shared/types.js";
export interface PolicyDecision {
    action: GuardAction;
    ruleId?: string;
}
/** 仅 * 和 ? 具有特殊含义，模式不会转换为用户提供的正则表达式。 */
export declare function matchGlob(pattern: string, value: string): boolean;
/**
 * 判断是否为显式类型：文件访问、原生扩展与端口监听在 1.0.0 新增，
 * 只有规则 kind 原样写出时才匹配，省略 kind 或使用通配的旧规则不作用于它们。
 */
export declare function isExplicitKind(kind: string): boolean;
/** 判断规则的 kind 是否覆盖事件类型；显式类型不接受省略或通配。 */
export declare function kindMatches(kind: GuardRule["kind"], eventKind: string): boolean;
/** 规则按顺序覆盖默认行为，首个匹配生效；未匹配行为仅审计。 */
export declare function decide(event: GuardEvent, rules: readonly GuardRule[]): PolicyDecision;
/** 按配置规则评估事件，返回首条匹配规则的动作。 */
export declare function evaluatePolicy(settings: GuardSettings, event: GuardEvent): PolicyDecision;
export declare class GuardDeniedError extends Error {
    readonly code = "GUARD_DENIED";
    readonly operation: string;
    readonly ruleId?: string;
    /** 创建带操作名与规则编号的拒绝错误。 */
    constructor(operation: string, ruleId?: string);
}
