import type { GuardEvent, GuardSettings } from "../shared/types.js"
import { runtimeEventDecision } from "../runtime/policy.js"

/** 只按宿主快照与可见字段重算；客体的规则、动作和脱敏声明不授予权限。 */
export function hostDecision(settings: GuardSettings, event: GuardEvent) {
  return runtimeEventDecision(settings, {
    kind: event.kind,
    operation: event.operation,
    target: event.target,
    plugin: event.plugin,
    // 脚本标记只能收紧默认动作；不传递客体的动作、规则或脱敏匹配声明。
    details: event.details?.scriptExecution === true ? { scriptExecution: true } : undefined,
  })
}
