import type { GuardEvent, GuardSettings } from "../shared/types.js";
/** 只按宿主快照与可见字段重算；客体的规则、动作和脱敏声明不授予权限。 */
export declare function hostDecision(settings: GuardSettings, event: GuardEvent): import("../config/policy.js").PolicyDecision;
