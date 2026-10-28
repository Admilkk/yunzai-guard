import type { GuardSettings } from "../shared/types.js";
type Alerts = GuardSettings["alerts"];
type Baseline = GuardSettings["baseline"];
type Sources = GuardSettings["sources"];
/** 读取字符串数组配置：元素非空、无控制字符，数量与长度有上限。 */
export declare function stringList(value: unknown, fallback: string[], location: string, maxItems?: number, maxLength?: number): string[];
/** 解析告警配置：通知渠道、触发类别、Webhook 转发范围与限流。 */
export declare function parseAlerts(value: unknown): Alerts;
/** 解析权限基线配置：学习时长、覆盖的行为类型、忽略项与上限。 */
export declare function parseBaseline(value: unknown): Baseline;
/** 解析插件来源校验配置：扫描间隔与忽略的插件目录。 */
export declare function parseSources(value: unknown): Sources;
export {};
