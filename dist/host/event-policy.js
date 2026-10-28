import { hostDecision } from "./policy.js";
import { copyAuditData } from "../audit/protocol.js";
import { sandboxDecision } from "../plugin-sandbox/policy.js";
const nativeCleanupOperations = new Set([
    "native.registration-cleanup-unconfirmed",
    "native.cleanup-unconfirmed",
]);
/** 日志移除证据字段前重新授权核心 IPC；传输类型仅供参考。 */
export function authorizeHostEvent(settings, input) {
    try {
        input = copyAuditData(input);
    }
    catch {
        return undefined;
    }
    if (!input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
        return undefined;
    const values = Object.create(null);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input)))
        if (descriptor.enumerable && "value" in descriptor)
            values[key] = descriptor.value;
    if (!["kind", "operation", "target"].every(key => typeof values[key] === "string" && values[key].length <= 4096))
        return undefined;
    const event = {
        kind: values.kind,
        operation: values.operation,
        target: values.target,
    };
    for (const key of ["plugin", "timestamp"])
        if (typeof values[key] === "string" && values[key].length <= 4096)
            Reflect.set(event, key, values[key]);
    if (values.details && typeof values.details === "object" && !Array.isArray(values.details)) {
        event.details = Object.create(null);
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(values.details)))
            if (descriptor.enumerable && "value" in descriptor)
                event.details[key] = descriptor.value;
    }
    let decision = hostDecision(settings, event);
    if (event.kind === "plugin-sandbox") {
        const native = settings.pluginSandbox.native.plugins.find(plugin => plugin.enabled && plugin.id === event.plugin);
        if (native &&
            event.target === native.id &&
            (nativeCleanupOperations.has(event.operation) ||
                (event.operation === "native.adapter-cleanup-unconfirmed" && native.adapters)))
            decision = { action: "restart" };
        else if (native && event.operation === "native.hook" && !decision.ruleId)
            decision = { action: native.hookAction };
        const legacy = settings.pluginSandbox.plugins.find(plugin => plugin.enabled && plugin.id === event.plugin);
        if (legacy && event.operation.startsWith("sandbox.")) {
            decision = sandboxDecision(settings, legacy, event);
            if (!decision.ruleId && event.operation === "sandbox.violation")
                decision = { action: legacy.violationAction };
            else if (!decision.ruleId && event.operation === "sandbox.hook")
                decision = { action: legacy.hookAction };
        }
    }
    return { ...event, ...decision };
}
//# sourceMappingURL=event-policy.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("host/event-policy.ts", { authorizeHostEvent })
