import type { GuardAction, GuardRule } from "../shared/types.js";
/** 校验值为普通对象，否则抛出带位置的配置错误。 */
export declare function object(value: unknown, location: string): Record<string, unknown>;
/** 拒绝不在允许列表中的配置键。 */
export declare function keys(value: Record<string, unknown>, allowed: string[], location: string): void;
/** 读取整数配置，缺省时使用默认值并检查上下限。 */
export declare function number(value: unknown, fallback: number, location: string, min: number, max: number): number;
/** 读取布尔配置，缺省时使用默认值。 */
export declare function boolean(value: unknown, fallback: boolean, location: string): boolean;
/** 读取非空字符串配置并限制长度。 */
export declare function string(value: unknown, location: string, maxLength?: number): string;
/** 读取规则动作（audit/deny/restart）。 */
export declare function action(value: unknown, fallback: GuardAction, location: string): GuardAction;
/** 解析并校验一条规则。 */
export declare function rule(value: unknown, index: number | string): GuardRule;
