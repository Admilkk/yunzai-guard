import { M } from "../shared/messages.js";
const states = new Set(["disabled", "pending", "protected", "changed", "inspection-failed"]);
const counters = ["imports", "loads", "registered", "calls", "blocked", "unwrapped"];
/** 校验为普通对象。 */
function object(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(M.monitor.shape);
    return value;
}
/** 验证 worker 提示信息，仅将受限的公开字段复制到宿主状态。 */
export function parseMonitorReport(value, targetCount) {
    const report = object(value);
    if (!Array.isArray(report.targets) || report.targets.length !== targetCount)
        throw new Error(M.monitor.targetCount);
    const targets = report.targets.map(item => {
        const row = object(item);
        if (typeof row.state !== "string" || !states.has(row.state))
            throw new Error(M.monitor.state);
        if (row.reason !== undefined && row.reason !== "missing" && row.reason !== "inspection-failed")
            throw new Error(M.monitor.reason);
        return { state: row.state, ...(row.reason ? { reason: row.reason } : {}) };
    });
    const plugins = object(report.plugins);
    if (!Array.isArray(plugins.entries) ||
        plugins.entries.length > 128 ||
        typeof plugins.truncated !== "boolean")
        throw new Error(M.monitor.plugins);
    const entries = plugins.entries.map(item => {
        const row = object(item);
        if (typeof row.name !== "string" || row.name.length > 128)
            throw new Error(M.monitor.pluginName);
        const result = { name: row.name };
        for (const key of counters) {
            if (!Number.isSafeInteger(row[key]) || Number(row[key]) < 0)
                throw new Error(M.monitor.counter);
            result[key] = Number(row[key]);
        }
        return result;
    });
    return { targets, plugins: { entries, truncated: plugins.truncated } };
}
/** 合并配置目标与工作进程报告，生成 status 中的监控状态。 */
export function monitorStatus(configuredTargets, snapshot, live = false, now = Date.now()) {
    return {
        source: "worker-reported",
        freshness: !snapshot
            ? "unavailable"
            : live && now - snapshot.receivedAt <= 10000
                ? "current"
                : "stale",
        receivedAt: snapshot?.receivedAt,
        targets: configuredTargets.map((target, index) => ({
            target,
            ...(snapshot?.report.targets[index] ?? { state: "unreported" }),
        })),
        plugins: snapshot?.report.plugins ?? { entries: [], truncated: false },
    };
}
//# sourceMappingURL=report.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("monitor/report.ts", { parseMonitorReport, monitorStatus })
