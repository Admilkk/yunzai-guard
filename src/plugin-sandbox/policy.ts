import { decide } from "../config/policy.js"
import type { GuardEvent, GuardSettings } from "../shared/types.js"
import type { SandboxPlugin } from "./types.js"

/** 全局约束先于逐插件规则；旧事件名称仅作输入别名。 */
export function sandboxDecision(settings: GuardSettings, plugin: SandboxPlugin, event: GuardEvent) {
  for (const rule of [...settings.rules, ...plugin.rules]) {
    for (const candidate of [
      event,
      { ...event, kind: "strict-js", operation: event.operation.replace(/^sandbox\./, "strict.") },
    ]) {
      const decision = decide(candidate, [rule])
      if (decision.ruleId) return decision
    }
  }
  return { action: "audit" as const }
}
