import { parseSettings } from "./index.js";
const reloadKeys = [
    "rules",
    "monitor",
    "protect",
    "pluginSandbox",
    "isolationMode",
    "sandbox",
    "startupTimeout",
    "shutdownTimeout",
    "handshakeTimeout",
];
const liveAuditKeys = [
    "maxEventsPerSecond",
    "maxBytes",
    "maxFiles",
    "maxDays",
    "durability",
];
/** 比较新旧配置，拆分为直接生效、重建业务进程与重启宿主三类字段。 */
export function planSettingsUpdate(active, next) {
    const current = parseSettings(active);
    const desired = parseSettings(next);
    const changed = (before, after) => JSON.stringify(before) !== JSON.stringify(after);
    const liveFields = [];
    if (changed(current.recovery, desired.recovery))
        liveFields.push("recovery");
    if (changed(current.update, desired.update))
        liveFields.push("update");
    for (const key of ["alerts", "baseline", "sources"])
        if (changed(current[key], desired[key]))
            liveFields.push(key);
    for (const key of liveAuditKeys)
        if (current.audit[key] !== desired.audit[key])
            liveFields.push(`audit.${key}`);
    const reloadFields = reloadKeys.filter(key => changed(current[key], desired[key]));
    if (current.audit.maxQueue !== desired.audit.maxQueue)
        reloadFields.push("audit.maxQueue");
    if (current.audit.coalesceMs !== desired.audit.coalesceMs)
        reloadFields.push("audit.coalesceMs");
    if (current.log.maxDays !== desired.log.maxDays)
        liveFields.push("log.maxDays");
    const restartFields = current.controlPort !== desired.controlPort ? ["controlPort"] : [];
    if (current.log.maxBytes !== desired.log.maxBytes)
        restartFields.push("log.maxBytes");
    return {
        live: parseSettings({
            ...current,
            recovery: desired.recovery,
            update: desired.update,
            alerts: desired.alerts,
            baseline: desired.baseline,
            sources: desired.sources,
            audit: {
                ...desired.audit,
                maxQueue: current.audit.maxQueue,
                coalesceMs: current.audit.coalesceMs,
            },
            log: { maxBytes: current.log.maxBytes, maxDays: desired.log.maxDays },
        }),
        candidate: parseSettings({
            ...desired,
            controlPort: current.controlPort,
            log: { maxBytes: current.log.maxBytes, maxDays: desired.log.maxDays },
        }),
        liveFields,
        reloadFields,
        restartFields,
    };
}
//# sourceMappingURL=update.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("config/update.ts", { planSettingsUpdate })
