import path from "node:path"
import { samplePolicyDecision, scriptExecutionDetails } from "../config/sample-policy.js"
import type { SettingsApplyState } from "../config/update.js"
import type { GuardSettings } from "../shared/types.js"
import { readJsonFile, writeJsonFile } from "../shared/files.js"
import { sha256 } from "../shared/hash.js"
import { redactAuditText } from "../audit/redaction.js"
import { authorizeHostEvent } from "../host/event-policy.js"
import { readSettingsDocument } from "./guard-settings.js"
import { readAudit, type AuditEntry, type AuditCoverage } from "./monitor.js"

const pageSize = 100
const pagesPerAction = 5
const maxAcknowledged = 2000
const stateFilename = "panel-task-state.json"

export interface TaskCase {
  id: string
  plugin: string
  kind: string
  operation: string
  target: string
  ruleId?: string
  currentRuleId?: string
  action: "deny" | "restart"
  currentAction: "audit" | "deny" | "restart"
  count: number
  lastAt: number
  entry: AuditEntry
  uncertain: boolean
  acknowledged: boolean
}

export interface TaskCoverage {
  complete: false
  truncated: boolean
  recordsRead: number
  sampled: number
  matched: number
  windowStart?: number
  windowEnd?: number
  lossReported: boolean
  errors: string[]
}

export interface TaskCases {
  revision: string
  cases: TaskCase[]
  coverage: TaskCoverage
}

interface Acknowledgment {
  id: string
  time: number
}

/** 已核对状态只保存有界的上下文摘要，不复制审计数据。 */
function acknowledgments(stateDir: string): { items: Acknowledgment[]; error?: string } {
  try {
    const value = readJsonFile(path.join(stateDir, stateFilename), 256 * 1024)
    if (value === undefined) return { items: [] }
    if (!value || typeof value !== "object" || !Array.isArray((value as { items?: unknown }).items))
      throw new Error("invalid task state")
    const items = (value as { items: unknown[] }).items
      .filter(
        (item): item is Acknowledgment =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof (item as Acknowledgment).id === "string" &&
          /^[a-f0-9]{64}$/.test((item as Acknowledgment).id) &&
          Number.isSafeInteger((item as Acknowledgment).time) &&
          (item as Acknowledgment).time >= 0,
      )
      .slice(-maxAcknowledged)
    return { items }
  } catch {
    return { items: [], error: "待办状态读取失败" }
  }
}

/** 读取有界样本；旧 JSONL 不同分页由 readAudit 共享同一窗口。 */
function samples(stateDir: string, plugin?: string) {
  const entries = new Map<string, AuditEntry>()
  const coverages: AuditCoverage[] = []
  let matched = 0
  let limited = false
  for (const action of ["deny", "restart"] as const) {
    for (let page = 1; page <= pagesPerAction; page++) {
      const result = readAudit(stateDir, { action, page, pageSize, ...(plugin ? { plugin } : {}) })
      if (page === 1) matched += result.total
      coverages.push(result.coverage)
      for (const entry of result.items) entries.set(entry.id, entry)
      if (!result.hasMore) break
      if (page === pagesPerAction) limited = true
    }
  }
  const windows = new Set(
    coverages.map(item => `${item.windowStart}:${item.windowEnd}:${item.recordsRead}`),
  )
  const first = coverages[0]
  const coverage: TaskCoverage = {
    complete: false,
    truncated:
      limited ||
      windows.size > 1 ||
      coverages.some(item => item.truncated || item.invalidLines > 0 || item.filesSkipped > 0),
    recordsRead: Math.max(0, ...coverages.map(item => item.recordsRead)),
    sampled: entries.size,
    matched,
    windowStart: first?.windowStart,
    windowEnd: first?.windowEnd,
    lossReported: coverages.some(item => item.lossReported),
    errors: [...new Set(coverages.flatMap(item => item.errors))].slice(0, 8),
  }
  return { entries: [...entries.values()].sort((a, b) => b.time - a.time), coverage }
}

/** 同插件、行为、目标与规则才会合并；配置上下文变化后重新提示。 */
export function readTaskCases(
  stateDir: string,
  settings: GuardSettings,
  options: { includeAcknowledged?: boolean; plugin?: string } = {},
): TaskCases {
  const revision = sha256(readSettingsDocument(stateDir, settings).text)
  const activeRevision = sha256(JSON.stringify(settings))
  const state = acknowledgments(stateDir)
  const acknowledged = new Set(state.items.map(item => item.id))
  const { entries, coverage } = samples(stateDir, options.plugin)
  if (state.error) coverage.errors.push(state.error)
  const grouped = new Map<string, TaskCase>()
  for (const entry of entries) {
    let decision = samplePolicyDecision(entry, settings.rules)
    // 可确定的样本仍以宿主授权为准，原生清理等恢复约束可以覆盖显式规则。
    if (entry.kind === "self-protection" || !decision.uncertain) {
      const current = authorizeHostEvent(settings, {
        plugin: entry.plugin,
        kind: entry.kind,
        operation: entry.operation,
        target: entry.target,
        details: scriptExecutionDetails(entry.details),
      })
      if (current)
        decision = { action: current.action ?? "audit", ruleId: current.ruleId, uncertain: false }
    }
    if (!decision.uncertain && decision.action === "audit") continue
    if (entry.action !== "deny" && entry.action !== "restart") continue
    const id = sha256(
      JSON.stringify([
        revision,
        activeRevision,
        entry.plugin,
        entry.kind,
        entry.operation,
        entry.target,
        entry.ruleId ?? null,
        entry.action,
        decision.ruleId ?? null,
        decision.action,
        decision.uncertain,
      ]),
    )
    const existing = grouped.get(id)
    if (existing) {
      existing.count++
      continue
    }
    grouped.set(id, {
      id,
      plugin: entry.plugin,
      kind: entry.kind,
      operation: entry.operation,
      target: entry.target,
      ruleId: entry.ruleId,
      currentRuleId: decision.ruleId,
      action: entry.action,
      currentAction: decision.action,
      count: 1,
      lastAt: entry.time,
      entry,
      uncertain: decision.uncertain,
      acknowledged: acknowledged.has(id),
    })
  }
  return {
    revision,
    cases: [...grouped.values()].filter(item => options.includeAcknowledged || !item.acknowledged),
    coverage,
  }
}

/** 核对只改变待办状态；条件失效时拒绝确认旧卡片。 */
export function acknowledgeTaskCases(
  stateDir: string,
  settings: GuardSettings,
  ids: string[],
): TaskCases | undefined {
  const current = readTaskCases(stateDir, settings, { includeAcknowledged: true })
  const known = new Set(current.cases.map(item => item.id))
  if (ids.some(id => !known.has(id))) return undefined
  const previous = acknowledgments(stateDir).items
  const selected = new Set(ids)
  const items = [
    ...previous.filter(item => !selected.has(item.id)),
    ...ids.map(id => ({ id, time: Date.now() })),
  ].slice(-maxAcknowledged)
  writeJsonFile(path.join(stateDir, stateFilename), { items })
  return {
    ...current,
    cases: current.cases.filter(item => !item.acknowledged && !selected.has(item.id)),
  }
}

export interface PluginFinding {
  kind: "blocked" | "configuration" | "startup" | "unknown"
  title: string
  detail: string
  scope: "plugin" | "global"
  action: "review-cases" | "retry-apply" | "wait" | "restart-host" | "inspect-startup" | "view-logs"
  caseIds?: string[]
  evidence?: AuditEntry[]
}

/** 只列已有证据；全局错误不归因为某个插件。 */
export function diagnosePlugin(
  stateDir: string,
  settings: GuardSettings,
  plugin: string,
  apply?: SettingsApplyState,
  status: Record<string, unknown> = {},
) {
  const tasks = readTaskCases(stateDir, settings, { includeAcknowledged: true, plugin })
  const findings: PluginFinding[] = []
  if (tasks.cases.length)
    findings.push({
      kind: "blocked",
      title: "有拒绝 / 重启记录",
      detail: `${tasks.cases.length} 类近期记录`,
      scope: "plugin",
      action: "review-cases",
      caseIds: tasks.cases.map(item => item.id),
      evidence: tasks.cases.slice(0, 10).map(item => item.entry),
    })
  if (apply?.status === "failed")
    findings.push({
      kind: "configuration",
      title: "配置应用失败",
      detail: redactAuditText(apply.error ?? "未提供错误详情"),
      scope: "global",
      action: "retry-apply",
    })
  else if (apply?.status === "applying")
    findings.push({
      kind: "configuration",
      title: "配置应用中",
      detail: apply.reloadFields.length ? "重启业务中" : "等待宿主确认",
      scope: "global",
      action: "wait",
    })
  else if (apply?.status === "pending-restart")
    findings.push({
      kind: "configuration",
      title: "配置待宿主重启",
      detail: "通过进程管理器重启宿主",
      scope: "global",
      action: "restart-host",
    })
  if (
    typeof status.trippedReason === "string" ||
    status.phase === "tripped" ||
    status.phase === "backoff"
  )
    findings.push({
      kind: "startup",
      title: status.phase === "backoff" ? "业务恢复中" : "业务已熔断",
      detail:
        typeof status.trippedReason === "string"
          ? redactAuditText(status.trippedReason)
          : "查看宿主启动日志",
      scope: "global",
      action: "inspect-startup",
    })
  if (!findings.some(item => item.scope === "plugin"))
    findings.unshift({
      kind: "unknown",
      title: "未定位",
      detail: "未找到该插件的关联失败记录",
      scope: "plugin",
      action: "view-logs",
    })
  return {
    plugin,
    revision: tasks.revision,
    findings,
    cases: tasks.cases,
    coverage: tasks.coverage,
  }
}
