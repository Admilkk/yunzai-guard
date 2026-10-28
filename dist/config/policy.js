/** 仅 * 和 ? 具有特殊含义，模式不会转换为用户提供的正则表达式。 */
export function matchGlob(pattern, value) {
    let patternAt = 0;
    let valueAt = 0;
    let starAt = -1;
    let retryAt = 0;
    while (valueAt < value.length) {
        if (pattern[patternAt] === "?" || pattern[patternAt] === value[valueAt]) {
            patternAt++;
            valueAt++;
        }
        else if (pattern[patternAt] === "*") {
            starAt = patternAt++;
            retryAt = valueAt;
        }
        else if (starAt >= 0) {
            patternAt = starAt + 1;
            valueAt = ++retryAt;
        }
        else
            return false;
    }
    while (pattern[patternAt] === "*")
        patternAt++;
    return patternAt === pattern.length;
}
/**
 * 判断是否为显式类型：文件访问、原生扩展与端口监听在 1.0.0 新增，
 * 只有规则 kind 原样写出时才匹配，省略 kind 或使用通配的旧规则不作用于它们。
 */
export function isExplicitKind(kind) {
    return kind === "filesystem" || kind === "native" || kind === "listen";
}
/** 判断规则的 kind 是否覆盖事件类型；显式类型不接受省略或通配。 */
export function kindMatches(kind, eventKind) {
    const explicit = isExplicitKind(eventKind);
    if (kind === undefined)
        return !explicit;
    const kinds = typeof kind === "string" ? [kind] : kind;
    for (let index = 0; index < kinds.length; index++) {
        const pattern = kinds[index];
        if (explicit ? pattern === eventKind : matchGlob(pattern, eventKind))
            return true;
    }
    return false;
}
/** 规则按顺序覆盖默认行为，首个匹配生效；未匹配行为仅审计。 */
export function decide(event, rules) {
    for (let index = 0; index < rules.length; index++) {
        const rule = rules[index];
        if (!kindMatches(rule.kind, event.kind))
            continue;
        if (rule.plugin && !matchGlob(rule.plugin, event.plugin ?? "unknown"))
            continue;
        if (rule.operation && !matchGlob(rule.operation, event.operation))
            continue;
        if (rule.target && !matchGlob(rule.target, event.target))
            continue;
        return { action: rule.action, ruleId: rule.id };
    }
    return { action: "audit" };
}
/** 按配置规则评估事件，返回首条匹配规则的动作。 */
export function evaluatePolicy(settings, event) {
    return decide(event, settings.rules);
}
export class GuardDeniedError extends Error {
    code = "GUARD_DENIED";
    operation;
    ruleId;
    /** 创建带操作名与规则编号的拒绝错误。 */
    constructor(operation, ruleId) {
        super(`Yunzai Guard blocked ${operation}${ruleId ? ` (rule: ${ruleId})` : ""}`);
        this.name = "GuardDeniedError";
        this.operation = operation;
        this.ruleId = ruleId;
    }
}
//# sourceMappingURL=policy.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("config/policy.ts", { matchGlob, isExplicitKind, kindMatches, decide, evaluatePolicy, GuardDeniedError })
