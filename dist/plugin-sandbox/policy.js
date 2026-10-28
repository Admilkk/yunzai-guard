import { decide } from "../config/policy.js";
/** 全局约束先于逐插件规则；旧事件名称仅作输入别名。 */
export function sandboxDecision(settings, plugin, event) {
    for (const rule of [...settings.rules, ...plugin.rules]) {
        for (const candidate of [
            event,
            { ...event, kind: "strict-js", operation: event.operation.replace(/^sandbox\./, "strict.") },
        ]) {
            const decision = decide(candidate, [rule]);
            if (decision.ruleId)
                return decision;
        }
    }
    return { action: "audit" };
}
//# sourceMappingURL=policy.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("plugin-sandbox/policy.ts", { sandboxDecision })
