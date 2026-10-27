import { copyAuditData } from "./protocol.js"
import { redactAuditText } from "./redaction.js"
import { M } from "../shared/messages.js"

type Row = Record<string, unknown>
const secretKey =
  /token|password|passwd|secret|authorization|cookie|args|environment|headers|api[_-]?key|credential|nonce|signature|private[_-]?key/i
/** 判断为非数组的普通对象。 */
const row = (value: unknown): value is Row =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** 递归脱敏并截断记录内容。 */
function clean(value: unknown, depth = 0, budget = { nodes: 1024 }): unknown {
  if (--budget.nodes < 0 || depth > 8) return "[truncated]"
  if (typeof value === "string") return redactAuditText(value)
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.slice(0, 64).map(item => clean(item, depth + 1, budget))
  if (!row(value)) return null
  const result: Row = Object.create(null)
  for (const [key, item] of Object.entries(value).slice(0, 64))
    result[key] = secretKey.test(key) ? "[redacted]" : clean(item, depth + 1, budget)
  return result
}

export interface StoredAuditRecord {
  sequence: number
  hostPid: number
  time: number
  type: string
  plugin: string
  kind: string
  operation: string
  target: string
  action: string
  ruleId: string | null
  blocked: number | null
  search: string
  payload: string
  bytes: number
  lossReported: number
}

/** 把输入转为可落盘的脱敏审计记录。 */
export function storedAuditRecord(input: unknown): StoredAuditRecord {
  const value = clean(copyAuditData(input))
  if (
    !row(value) ||
    typeof value.type !== "string" ||
    !value.type ||
    value.type.length > 100 ||
    typeof value.time !== "number" ||
    value.time < 0 ||
    value.time > 8640000000000000
  )
    throw new TypeError(M.audit.storedEnvelope)
  const event = row(value.event) ? value.event : undefined
  const text = (input: unknown, fallback: string) =>
    typeof input === "string" && input ? input : fallback
  const plugin = text(event?.plugin ?? value.plugin, "unknown")
  const kind = text(event?.kind, value.type.startsWith("audit-") ? "coverage" : "system")
  const operation = text(event?.operation, value.type)
  const target = text(event?.target, "—")
  const action = ["audit", "deny", "restart"].includes(String(event?.action))
    ? String(event!.action)
    : "info"
  const ruleId = typeof event?.ruleId === "string" ? event.ruleId : null
  const reported = event?.blocked ?? (row(event?.details) ? event.details.blocked : undefined)
  const payload = JSON.stringify(value)
  const sequence =
    typeof value.sequence === "number" && Number.isSafeInteger(value.sequence) ? value.sequence : 0
  const hostPid =
    typeof value.hostPid === "number" && Number.isSafeInteger(value.hostPid) ? value.hostPid : 0
  return {
    sequence,
    hostPid,
    time: value.time,
    type: value.type,
    plugin,
    kind,
    operation,
    target,
    action,
    ruleId,
    blocked: typeof reported === "boolean" ? Number(reported) : null,
    search: [plugin, kind, operation, target, value.type, ruleId ?? ""].join(" ").toLowerCase(),
    payload,
    bytes: Buffer.byteLength(payload),
    lossReported: Number(
      kind === "coverage" &&
        (Number(value.incomplete ?? 0) > 0 ||
          Number(value.unknown ?? 0) > 0 ||
          Number(value.rejected ?? 0) > 0 ||
          value.outcome === "incomplete" ||
          value.outcome === "settled-with-loss"),
    ),
  }
}
