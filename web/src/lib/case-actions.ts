import { addEventShortcut, eventShortcutProblem, siteShortcutTarget } from "./quick-actions"
import { sampleDecision } from "./rules"
import { rulesOverlap } from "./draft-actions"
import type { Draft, Rule, SettingsApplyState, TaskCase, TaskCases } from "../types"
import { api, ApiError } from "../api"

export type CaseChoice = { item: TaskCase; action: "keep" | "audit" | "deny" }
export const caseScope = (item: TaskCase) => (siteShortcutTarget(item.entry) ? "site" : "exact")
export const caseProblem = (item: TaskCase) => eventShortcutProblem(item.entry, caseScope(item))
export const caseSignature = (item: TaskCase) =>
  JSON.stringify([
    item.plugin,
    item.kind,
    item.operation,
    item.target,
    item.ruleId,
    item.currentRuleId,
    item.action,
    item.currentAction,
    item.uncertain,
  ])

/** 批量操作先核对范围冲突，再生成配置；多条记录不会触发多次保存。 */
export function applyCaseChoices(document: Draft, choices: CaseChoice[]): void {
  for (const { item, action } of choices) {
    if (action === "keep") continue
    const problem = caseProblem(item)
    if (problem) throw new Error(`${item.plugin}：${problem}`)
  }
  const rules = choices.map(({ item, action }, index): Rule => ({
    id: `batch.${index}`,
    plugin: item.plugin,
    kind: item.kind,
    operation: item.operation,
    target: siteShortcutTarget(item.entry) ?? item.target,
    action: action === "keep" ? (item.currentAction ?? item.action) : action,
  }))
  for (let i = 0; i < rules.length; i++)
    for (let j = i + 1; j < rules.length; j++)
      if (rules[i].action !== rules[j].action && rulesOverlap(rules[i], rules[j]))
        throw new Error("所选范围有冲突，请调整动作")
  const next = structuredClone(document)
  for (const { item, action } of choices) {
    if (action === "keep") continue
    const decision = sampleDecision(item.entry, next.rules ?? [])
    if (!decision.uncertain && decision.action === action) continue
    addEventShortcut(
      next,
      item.entry,
      action,
      `panel.event.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`,
      caseScope(item),
    )
  }
  if (next.rules) document.rules = next.rules
}

/** 单项核对与暂存只确认用户实际看到的上下文，版本变化由服务端拒绝。 */
export async function acknowledgeCases(items: TaskCase[], revision: string): Promise<void> {
  if (!items.length) return
  await api("/api/tasks/ack", {
    method: "POST",
    body: JSON.stringify({ ids: [...new Set(items.map(item => item.id))], revision }),
  })
}

/** 等待可提前结束的下一次状态查询，整个确认过程最多 15 秒。 */
function waitForApply(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, 500)
    signal.addEventListener("abort", finish, { once: true })
    if (signal.aborted) finish()
  })
}

/** 仅迁移本次已授权保存后的 keep 项；外部保存、失败或未生效均保留待办。 */
export async function acknowledgeCasesAfterApply(
  items: TaskCase[],
  committedRevision: string,
): Promise<boolean> {
  if (!items.length) return true
  const controller = new AbortController()
  const signal = controller.signal
  const deadline = setTimeout(() => controller.abort(), 15000)
  type AppliedSettings = { revision: string; apply?: SettingsApplyState }
  try {
    while (!signal.aborted) {
      const settings = await api<AppliedSettings>("/api/settings", { signal })
      if (signal.aborted || settings.revision !== committedRevision) return false
      if (settings.apply?.status === "applying") {
        await waitForApply(signal)
        continue
      }
      if (settings.apply?.status !== "applied") return false
      const latest = await api<TaskCases>("/api/tasks", { signal })
      if (signal.aborted || latest.revision !== committedRevision) return false
      const signatures = new Set(items.map(caseSignature))
      const matching = latest.cases.filter(item => signatures.has(caseSignature(item)))
      if (!matching.length) return false
      // 查询待办期间也可能有其他保存；再核对一次实际应用代次。
      const confirmed = await api<AppliedSettings>("/api/settings", { signal })
      if (
        signal.aborted ||
        confirmed.revision !== committedRevision ||
        confirmed.apply?.status !== "applied" ||
        confirmed.apply.revision !== settings.apply.revision
      )
        return false
      await api("/api/tasks/ack", {
        method: "POST",
        signal,
        body: JSON.stringify({ ids: matching.map(item => item.id), revision: committedRevision }),
      })
      return new Set(matching.map(caseSignature)).size === signatures.size
    }
    return false
  } catch (error) {
    if (signal.aborted || (error instanceof ApiError && error.status === 409)) return false
    throw error
  } finally {
    clearTimeout(deadline)
  }
}
