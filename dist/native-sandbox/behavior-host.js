import { object } from "../config/validation.js";
import { hostDecision } from "../host/policy.js";
import { M } from "../shared/messages.js";
/** 受限进程仅上报 JS 观察结果，不能提供宿主身份或新增权限。 */
export function validateNativeBehaviorEvent(settings, pluginId, input) {
    const value = object(input, "native behavior");
    const installed = value.kind === "guard" &&
        value.operation === "instrumentation-installed" &&
        value.target === "builtin-js-entrypoints";
    const action = installed && value.action === undefined ? "audit" : value.action;
    if (typeof value.kind !== "string" ||
        (!["network", "process", "runtime", "integrity", "self-protection"].includes(value.kind) &&
            !installed) ||
        typeof value.operation !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(value.operation) ||
        typeof value.target !== "string" ||
        value.target.length > 512 ||
        typeof action !== "string" ||
        !["audit", "deny", "restart"].includes(action) ||
        (value.ruleId != null && (typeof value.ruleId !== "string" || value.ruleId.length > 100)))
        throw new Error(M.nativeSandbox.behaviorFields);
    // 动作与规则标签都是自报；省略、伪造或改成 audit 均不能绕过重算。
    const decision = hostDecision(settings, {
        kind: value.kind,
        operation: value.operation,
        target: value.target,
        plugin: pluginId,
    });
    const details = value.details === undefined ? {} : object(value.details, "native behavior details");
    const runtime = details.runtime === undefined ? undefined : object(details.runtime, "native behavior runtime");
    const guestRuntime = runtime &&
        typeof runtime.id === "string" &&
        runtime.id.length <= 128 &&
        typeof runtime.kind === "string" &&
        ["thread", "node-process"].includes(runtime.kind)
        ? {
            id: runtime.id,
            kind: runtime.kind,
            ...(Number.isSafeInteger(runtime.threadId) && Number(runtime.threadId) >= 0
                ? { threadId: runtime.threadId }
                : {}),
        }
        : undefined;
    return {
        kind: value.kind,
        operation: value.operation,
        target: value.target.replace(/[\x00-\x1f\x7f]/g, ""),
        plugin: pluginId,
        ...decision,
        timestamp: new Date().toISOString(),
        details: {
            source: "guest-reported",
            observability: "js-entrypoints",
            argumentsRedacted: true,
            reportedBlocked: details.blocked === true,
            ...(guestRuntime ? { guestRuntime } : {}),
        },
    };
}
//# sourceMappingURL=behavior-host.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("native-sandbox/behavior-host.ts", { validateNativeBehaviorEvent })
