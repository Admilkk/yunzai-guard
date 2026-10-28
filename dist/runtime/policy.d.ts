import { type PolicyDecision } from "../config/policy.js";
import type { GuardEvent, GuardSettings } from "../shared/types.js";
/** 默认审计策略下，可选遥测丢失不能停止应用。 */
export declare function runtimeFailureDecision(settings: GuardSettings, event: GuardEvent): PolicyDecision;
/** 传输标签不构成授权；动作仅由当前策略决定。 */
export declare function runtimeEventDecision(settings: GuardSettings, event: GuardEvent): PolicyDecision;
