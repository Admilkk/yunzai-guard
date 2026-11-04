import { decide, defaultPolicyDecision, matchGlob } from "./policy.js"
import type { GuardAction, GuardEvent, GuardRule } from "../shared/types.js"

type PolicySample = Pick<GuardEvent, "plugin" | "kind" | "operation" | "target" | "details">
export interface SamplePolicyDecision {
  action: GuardAction
  ruleId?: string
  uncertain: boolean
}

/** 原始事件和面板审计包装共用最小的收紧证据，不转交其他详情。 */
export function scriptExecutionDetails(
  details: GuardEvent["details"],
): { scriptExecution: true } | undefined {
  const event = details?.event
  const nested =
    event && typeof event === "object" ? (event as Record<string, unknown>).details : undefined
  return details?.scriptExecution === true ||
    (nested &&
      typeof nested === "object" &&
      (nested as Record<string, unknown>).scriptExecution === true)
    ? { scriptExecution: true }
    : undefined
}

/** 审计脱敏后，只对仍能确认的匹配给出确定结果。 */
export function samplePolicyDecision(
  event: PolicySample,
  rules: readonly GuardRule[],
): SamplePolicyDecision {
  for (const rule of rules) {
    if (decide(event, [{ ...rule, target: undefined }]).ruleId !== rule.id) continue
    if (!rule.target || rule.target === "*")
      return { action: rule.action, ruleId: rule.id, uncertain: false }
    if (event.target.includes("[path-redacted]")) {
      try {
        const origin = new URL(event.target).origin
        const parts = rule.target.match(/^([a-z]+:\/\/[^/]+)(\/.*)?$/i)
        if (parts && !matchGlob(parts[1], origin)) continue
        if (parts?.[2] === "/*") return { action: rule.action, ruleId: rule.id, uncertain: false }
      } catch {}
      return { action: rule.action, ruleId: rule.id, uncertain: true }
    }
    if (
      (event.kind === "process" && ["exec", "execSync"].includes(event.operation)) ||
      /\[(?:redacted|path-redacted|truncated)\]/i.test(event.target)
    )
      return { action: rule.action, ruleId: rule.id, uncertain: true }
    if (decide(event, [rule]).ruleId === rule.id)
      return { action: rule.action, ruleId: rule.id, uncertain: false }
  }
  return {
    ...defaultPolicyDecision({ ...event, details: scriptExecutionDetails(event.details) }),
    uncertain: false,
  }
}
