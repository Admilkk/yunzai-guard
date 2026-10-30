import { readJsonFile, writeJsonFile } from "../shared/files.js";
import { redactAuditText as redact } from "../audit/redaction.js";
import { M } from "../shared/messages.js";
const maxFileBytes = 65536;
const maxFailures = 256;
/** 损坏的计数不能放行无限重启：无法解析时视为已熔断，保留控制端点供恢复。 */
export function readRecoveryState(file) {
    try {
        const value = readJsonFile(file, maxFileBytes);
        if (value === undefined)
            return { version: 1, failures: [], tripped: false };
        if (!value || typeof value !== "object")
            throw new Error(M.host.recoveryState);
        const data = value;
        if (data.version !== 1 || typeof data.tripped !== "boolean" || !Array.isArray(data.failures))
            throw new Error(M.host.recoveryState);
        const failures = [];
        for (const item of data.failures) {
            if (!item || typeof item !== "object")
                throw new Error(M.host.failureRecord);
            const row = item;
            if (typeof row.time !== "number" ||
                !Number.isFinite(row.time) ||
                typeof row.reason !== "string")
                throw new Error(M.host.failureRecord);
            failures.push({ time: row.time, reason: redact(row.reason) });
        }
        return {
            version: 1,
            failures: failures.slice(-maxFailures),
            tripped: data.tripped,
            reason: typeof data.reason === "string" ? redact(data.reason) : undefined,
        };
    }
    catch {
        return { version: 1, failures: [], tripped: true, reason: "recovery-state-invalid" };
    }
}
/** 原子写入熔断与恢复状态。 */
export function saveRecoveryState(file, state) {
    writeJsonFile(file, state);
}
//# sourceMappingURL=recovery.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("host/recovery.ts", { readRecoveryState, saveRecoveryState })
