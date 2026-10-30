import { readJsonFile, writeJsonFile } from "../shared/files.js"
import { redactAuditText as redact } from "../audit/redaction.js"
import { M } from "../shared/messages.js"

/** 持久化的重启预算与熔断状态。 */
export interface RecoveryState {
  version: 1
  failures: Array<{ time: number; reason: string }>
  tripped: boolean
  reason?: string
}

const maxFileBytes = 65536
const maxFailures = 256

/** 损坏的计数不能放行无限重启：无法解析时视为已熔断，保留控制端点供恢复。 */
export function readRecoveryState(file: string): RecoveryState {
  try {
    const value = readJsonFile(file, maxFileBytes)
    if (value === undefined) return { version: 1, failures: [], tripped: false }
    if (!value || typeof value !== "object") throw new Error(M.host.recoveryState)
    const data = value as Record<string, unknown>
    if (data.version !== 1 || typeof data.tripped !== "boolean" || !Array.isArray(data.failures))
      throw new Error(M.host.recoveryState)
    const failures: RecoveryState["failures"] = []
    for (const item of data.failures) {
      if (!item || typeof item !== "object") throw new Error(M.host.failureRecord)
      const row = item as Record<string, unknown>
      if (
        typeof row.time !== "number" ||
        !Number.isFinite(row.time) ||
        typeof row.reason !== "string"
      )
        throw new Error(M.host.failureRecord)
      failures.push({ time: row.time, reason: redact(row.reason) })
    }
    return {
      version: 1,
      failures: failures.slice(-maxFailures),
      tripped: data.tripped,
      reason: typeof data.reason === "string" ? redact(data.reason) : undefined,
    }
  } catch {
    return { version: 1, failures: [], tripped: true, reason: "recovery-state-invalid" }
  }
}

/** 原子写入熔断与恢复状态。 */
export function saveRecoveryState(file: string, state: RecoveryState): void {
  writeJsonFile(file, state)
}
