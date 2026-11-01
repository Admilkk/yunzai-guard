import { decide } from "../../../src/config/policy.js"
import { canCreateRule, needsTarget } from "./rules"
import { categories, setPermission } from "./policy.js"
import type { AuditEntry, Draft, Rule, RuleAction } from "../types"

/** 只把策略匹配字段交给判定器，不把审计结果当作输入动作。 */
export function eventDecision(entry: AuditEntry, rules: Rule[]) {
  return decide(
    { plugin: entry.plugin, kind: entry.kind, operation: entry.operation, target: entry.target },
    rules,
  )
}

/** 路径脱敏时只提出明确标注的站点范围，保留协议与端口。 */
export function siteShortcutTarget(entry: AuditEntry): string | undefined {
  if (entry.kind !== "network" || !entry.target.includes("[path-redacted]")) return undefined
  try {
    const url = new URL(entry.target)
    if (
      !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      /[*?\[\]]/.test(url.hostname)
    )
      return undefined
    const target = `${url.origin}/*`
    return target.length <= 512 ? target : undefined
  } catch {
    return undefined
  }
}

/** 快捷操作必须能明确表达作用范围；站点范围须由调用方显式选择。 */
export function eventShortcutProblem(
  entry: AuditEntry,
  scope: "exact" | "site" = "exact",
): string | undefined {
  if (
    !canCreateRule(entry) ||
    !["network", "listen", "process", "filesystem", "native", "plugin"].includes(entry.kind)
  )
    return "该记录不支持快捷规则"
  if (
    !entry.plugin ||
    entry.plugin === "unknown" ||
    entry.plugin.toLowerCase() === "yunzai-guard" ||
    /[*?]/.test(entry.plugin)
  )
    return "该来源不支持快捷规则"
  if (
    scope === "site"
      ? !siteShortcutTarget(entry)
      : !entry.target ||
        entry.target === "—" ||
        needsTarget(entry) ||
        /[*?]/.test(entry.target) ||
        entry.target.length > 512
  )
    return "目标不完整或含通配符"
  if (
    !entry.operation ||
    /[*?]/.test(entry.operation) ||
    entry.operation.endsWith(".observed") ||
    entry.details?.enforcement === "after-change"
  )
    return "该行为不支持快捷处理"
}

/** 把精确事件规则放在首位，明确覆盖已有匹配；不更改原有规则。 */
export function addEventShortcut(
  document: Draft,
  entry: AuditEntry,
  action: RuleAction,
  id: string,
  scope: "exact" | "site" = "exact",
): void {
  const problem = eventShortcutProblem(entry, scope)
  if (problem) throw new Error(problem)
  const rules = (document.rules ??= [])
  const target = scope === "site" ? siteShortcutTarget(entry)! : entry.target
  const first = rules[0]
  if (
    (scope === "exact" && eventDecision(entry, rules).action === action) ||
    (first?.action === action &&
      first.plugin === entry.plugin &&
      first.kind === entry.kind &&
      first.operation === entry.operation &&
      first.target === target)
  )
    throw new Error("当前配置已采用该处理方式")
  if (rules.length >= 1000) throw new Error("最多 1000 条规则")
  if (rules.some(rule => rule.id === id)) throw new Error("规则标识重复，请重试")
  const rule: Rule = {
    id,
    plugin: entry.plugin,
    kind: entry.kind,
    operation: entry.operation,
    target,
    action,
  }
  rules.unshift(rule)
}

export const permissionPresets = [
  { id: "network", label: "限制联网", description: "禁止网络外联。" },
  {
    id: "commands",
    label: "限制外部命令",
    description: "禁用外部命令，保留工作线程权限。",
  },
  {
    id: "inherit",
    label: "恢复继承全局规则",
    description: "删除专属规则（含手动规则），恢复全局规则。",
  },
] as const
export type PermissionPreset = (typeof permissionPresets)[number]["id"]

/** 单插件和批量操作共享相同的权限套餐，先验证全部名称再修改。 */
export function applyPermissionPreset(
  document: Draft,
  plugins: string[],
  preset: PermissionPreset,
): void {
  const ids = [...new Set(plugins)]
  if (!ids.length) throw new Error("请先选择插件")
  if (!permissionPresets.some(item => item.id === preset)) throw new Error("无效权限套餐")
  for (const id of ids)
    if (!id || id === "unknown" || /[*?]/.test(id) || id.toLowerCase() === "yunzai-guard")
      throw new Error("插件来源不允许快捷配置")
  for (const id of ids) {
    if (preset === "inherit") {
      document.rules = (document.rules ?? []).filter(rule => rule.plugin !== id)
    } else if (preset === "network") {
      setPermission(
        document,
        id,
        categories.find(item => item.id === "network"),
        "deny",
      )
    } else {
      for (const [suffix, operation] of [
        ["exec", "exec*"],
        ["spawn", "spawn*"],
        ["fork", "fork"],
      ])
        setPermission(
          document,
          id,
          { id: `commands-${suffix}`, kind: "process", operation },
          "deny",
        )
    }
  }
  if ((document.rules?.length ?? 0) > 1000) throw new Error("应用后超过 1000 条规则")
}
