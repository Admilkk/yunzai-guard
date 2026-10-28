import type { GuardSettings } from "../shared/types.js"
import { parseSettings } from "./index.js"

export interface SettingsApplyState {
  status: "applied" | "applying" | "pending-restart" | "failed"
  mode: "live" | "worker-reload" | "host-restart"
  revision: number
  liveFields: string[]
  reloadFields: string[]
  restartFields: string[]
  error?: string
}

export interface SettingsUpdatePlan {
  live: GuardSettings
  candidate: GuardSettings
  liveFields: string[]
  reloadFields: string[]
  restartFields: string[]
}

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
] as const
const liveAuditKeys = [
  "maxEventsPerSecond",
  "maxBytes",
  "maxFiles",
  "maxDays",
  "durability",
] as const

/** 比较新旧配置，拆分为直接生效、重建业务进程与重启宿主三类字段。 */
export function planSettingsUpdate(active: GuardSettings, next: GuardSettings): SettingsUpdatePlan {
  const current = parseSettings(active)
  const desired = parseSettings(next)
  const changed = (before: unknown, after: unknown) =>
    JSON.stringify(before) !== JSON.stringify(after)
  const liveFields: string[] = []
  if (changed(current.recovery, desired.recovery)) liveFields.push("recovery")
  if (changed(current.update, desired.update)) liveFields.push("update")
  for (const key of ["alerts", "baseline", "sources"] as const)
    if (changed(current[key], desired[key])) liveFields.push(key)
  for (const key of liveAuditKeys)
    if (current.audit[key] !== desired.audit[key]) liveFields.push(`audit.${key}`)
  const reloadFields: string[] = reloadKeys.filter(key => changed(current[key], desired[key]))
  if (current.audit.maxQueue !== desired.audit.maxQueue) reloadFields.push("audit.maxQueue")
  if (current.audit.coalesceMs !== desired.audit.coalesceMs) reloadFields.push("audit.coalesceMs")
  if (current.log.maxDays !== desired.log.maxDays) liveFields.push("log.maxDays")
  const restartFields = current.controlPort !== desired.controlPort ? ["controlPort"] : []
  if (current.log.maxBytes !== desired.log.maxBytes) restartFields.push("log.maxBytes")
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
  }
}
