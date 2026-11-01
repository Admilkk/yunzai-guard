import type { GuardAction, GuardEvent, GuardRule } from "../shared/types.js";
type PolicySample = Pick<GuardEvent, "plugin" | "kind" | "operation" | "target">;
export interface SamplePolicyDecision {
    action: GuardAction;
    ruleId?: string;
    uncertain: boolean;
}
/** 审计脱敏后，只对仍能确认的匹配给出确定结果。 */
export declare function samplePolicyDecision(event: PolicySample, rules: readonly GuardRule[]): SamplePolicyDecision;
export {};
