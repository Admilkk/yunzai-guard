import { decide, matchGlob } from "./policy.js";
/** 审计脱敏后，只对仍能确认的匹配给出确定结果。 */
export function samplePolicyDecision(event, rules) {
    for (const rule of rules) {
        if (decide(event, [{ ...rule, target: undefined }]).ruleId !== rule.id)
            continue;
        if (!rule.target || rule.target === "*")
            return { action: rule.action, ruleId: rule.id, uncertain: false };
        if (event.target.includes("[path-redacted]")) {
            try {
                const origin = new URL(event.target).origin;
                const parts = rule.target.match(/^([a-z]+:\/\/[^/]+)(\/.*)?$/i);
                if (parts && !matchGlob(parts[1], origin))
                    continue;
                if (parts?.[2] === "/*")
                    return { action: rule.action, ruleId: rule.id, uncertain: false };
            }
            catch { }
            return { action: rule.action, ruleId: rule.id, uncertain: true };
        }
        if ((event.kind === "process" && ["exec", "execSync"].includes(event.operation)) ||
            /\[(?:redacted|path-redacted|truncated)\]/i.test(event.target))
            return { action: rule.action, ruleId: rule.id, uncertain: true };
        if (decide(event, [rule]).ruleId === rule.id)
            return { action: rule.action, ruleId: rule.id, uncertain: false };
    }
    return { action: "audit", uncertain: false };
}
//# sourceMappingURL=sample-policy.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("config/sample-policy.ts", { samplePolicyDecision })
