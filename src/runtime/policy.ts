import { evaluatePolicy, kindMatches, matchGlob, type PolicyDecision } from "../config/policy.js"
import type { GuardEvent, GuardRule, GuardSettings } from "../shared/types.js"
import { arrayIncludes } from "../protect/intrinsics.js"

/** 判断规则是否适用于该事件的类型。 */
function applicable(rule: GuardRule, event: GuardEvent): boolean {
  return (
    kindMatches(rule.kind, event.kind) &&
    (!rule.plugin || matchGlob(rule.plugin, event.plugin ?? "unknown")) &&
    (!rule.operation || matchGlob(rule.operation, event.operation))
  )
}

/** 默认审计策略下，可选遥测丢失不能停止应用。 */
export function runtimeFailureDecision(settings: GuardSettings, event: GuardEvent): PolicyDecision {
  const explicit = evaluatePolicy(settings, event)
  if (explicit.ruleId) return explicit
  let action: PolicyDecision["action"] = "audit"
  for (let index = 0; index < settings.rules.length; index++) {
    const rule = settings.rules[index]!
    if (rule.plugin && !matchGlob(rule.plugin, event.plugin ?? "unknown")) continue
    if (rule.action === "restart") return { action: "restart" }
    if (rule.action === "deny") action = "deny"
  }
  if (
    settings.protect.enabled &&
    (settings.protect.monitorInstrumentation || settings.protect.targets.length)
  ) {
    if (settings.protect.action === "restart") return { action: "restart" }
    if (settings.protect.action === "deny") action = "deny"
  }
  return { action }
}

/** 按当前配置重新评估事件的动作。 */
function currentDecision(settings: GuardSettings, event: GuardEvent): PolicyDecision {
  const decision = evaluatePolicy(settings, event)
  if (decision.ruleId) return decision
  if (event.kind === "runtime" && event.operation === "runtime-bootstrap-failed")
    return runtimeFailureDecision(settings, event)
  if (event.kind === "integrity" && settings.protect.enabled) {
    if (
      (event.operation === "instrumentation-change" && settings.protect.monitorInstrumentation) ||
      (event.operation === "protected-target-change" &&
        arrayIncludes(settings.protect.targets, event.target))
    )
      return { action: settings.protect.action }
  }
  return { action: "audit" }
}

/** 传输标签不构成授权；动作仅由当前策略决定。 */
export function runtimeEventDecision(settings: GuardSettings, event: GuardEvent): PolicyDecision {
  // 自保护是固定底线，不能被业务白名单或默认观察覆盖。
  if (event.kind === "self-protection") return { action: "deny" }
  const decision = currentDecision(settings, event)
  if (event.ruleId !== undefined) {
    let rule: GuardRule | undefined
    for (let index = 0; index < settings.rules.length; index++)
      if (settings.rules[index]!.id === event.ruleId) {
        rule = settings.rules[index]
        break
      }
    if (!rule || rule.action !== event.action || !applicable(rule, event)) return decision
    // 仅 shell 命令目标会在传输前有意缩减为可执行程序。
    // 报告仍是 JS 自报证据，不能独立证明完整命令已匹配。
    const redactedShell =
      event.kind === "process" &&
      arrayIncludes(["exec", "execSync"], event.operation) &&
      event.details?.argumentsRedacted === true
    if (!redactedShell && decision.ruleId !== rule.id) return decision
    if (redactedShell) {
      for (let index = 0; index < settings.rules.length; index++) {
        const earlier = settings.rules[index]!
        if (earlier.id === rule.id) break
        if (
          applicable(earlier, event) &&
          (!earlier.target || matchGlob(earlier.target, event.target))
        )
          return { action: earlier.action, ruleId: earlier.id }
      }
    }
    return { action: rule.action, ruleId: rule.id }
  }
  return decision
}
