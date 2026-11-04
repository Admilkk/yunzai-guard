import type { GuardAction, GuardEvent, GuardRule } from "../shared/types.js";
type PolicySample = Pick<GuardEvent, "plugin" | "kind" | "operation" | "target" | "details">;
export interface SamplePolicyDecision {
    action: GuardAction;
    ruleId?: string;
    uncertain: boolean;
}
/** 原始事件和面板审计包装共用最小的收紧证据，不转交其他详情。 */
export declare function scriptExecutionDetails(details: GuardEvent["details"]): {
    scriptExecution: true;
} | undefined;
/** 审计脱敏后，只对仍能确认的匹配给出确定结果。 */
export declare function samplePolicyDecision(event: PolicySample, rules: readonly GuardRule[]): SamplePolicyDecision;
export {};
