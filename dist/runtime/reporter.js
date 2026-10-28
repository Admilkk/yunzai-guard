import fs from "node:fs";
import { runtimeFailureDecision } from "./policy.js";
import { workerTransportStats, workerTransportIsIncomplete } from "./worker-transport.js";
const rawExit = process.exit.bind(process);
const rawWrite = fs.writeSync.bind(fs);
/** 在事件中附加运行时身份。 */
export function attach(event, identity) {
    return { ...event, details: { ...event.details, runtime: event.details?.runtime ?? identity } };
}
/** 报告运行时降级；非 audit 策略下直接退出进程。 */
export function reportFailure(settings, identity, reason) {
    const decision = runtimeFailureDecision(settings, {
        kind: "runtime",
        operation: "runtime-bootstrap-failed",
        target: identity.id,
        plugin: identity.originPlugin,
    });
    try {
        rawWrite(2, `[Yunzai Guard] runtime monitoring degraded: ${reason}\n`);
    }
    catch {
        // 遥测和 stderr 可能同时不可用；审计模式仍须保持业务行为。
    }
    if (decision.action !== "audit")
        rawExit(1);
    return decision;
}
/** 首次读取时上报一次传输摘要；传输不完整时把已结清的嵌套覆盖降为 incomplete。 */
export function trackCoverage(emit, target, nestedCoverage) {
    let reported = false;
    let incomplete = false;
    return () => {
        const transport = workerTransportStats();
        if (!reported && transport) {
            reported = true;
            incomplete = workerTransportIsIncomplete(transport);
            emit({
                kind: "runtime",
                operation: "worker-transport-summary",
                target,
                action: "audit",
                details: { transport },
            });
        }
        const coverage = nestedCoverage();
        return incomplete && coverage === "settled" ? "incomplete" : coverage;
    };
}
/** 为子运行时创建覆盖上报函数。 */
export function createReporter(sender, identity, nestedCoverage) {
    return trackCoverage(event => sender.offer(attach(event, identity)), "inherited-control", nestedCoverage);
}
/** 把无效回复数量计入密封帧。 */
export function addInvalidReplies(seal, invalidReplies) {
    return {
        ...seal,
        sourceCounters: {
            ...seal.sourceCounters,
            invalidReplies: Math.min(Number.MAX_SAFE_INTEGER, seal.sourceCounters.invalidReplies + invalidReplies),
        },
    };
}
//# sourceMappingURL=reporter.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("runtime/reporter.ts", { attach, reportFailure, trackCoverage, createReporter, addInvalidReplies })
