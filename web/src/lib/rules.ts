import { decide, matchGlob } from "../../../src/config/policy.js"
import type { AuditEntry, Rule } from "../types"

export const ruleScenes = [
  { id: "network", label: "网络访问", kind: "network" },
  { id: "listen", label: "端口监听", kind: "listen" },
  { id: "process", label: "外部命令", kind: "process", operation: "exec*" },
  { id: "worker", label: "工作线程", kind: "process", operation: "worker" },
  { id: "filesystem", label: "文件写入", kind: "filesystem" },
  { id: "native", label: "原生扩展", kind: "native" },
  { id: "plugin", label: "插件调用", kind: "plugin", operation: "plugin.call" },
  { id: "integrity", label: "函数修改", kind: "integrity" },
] as const

/** 判断事件能否直接生成规则。 */
export function canCreateRule(entry: AuditEntry): boolean {
  return (
    entry.action !== "info" &&
    !["self-protection", "coverage", "system", "guard", "runtime"].includes(entry.kind)
  )
}

/** 根据事件生成规则草稿。 */
export function eventRule(entry: AuditEntry): Partial<Rule> {
  let target = entry.target && entry.target !== "—" ? entry.target : undefined
  if (target?.includes("[path-redacted]")) {
    try {
      target = new URL(target).origin + "/*"
    } catch {
      target = undefined
    }
  } else if (needsTarget(entry)) target = undefined
  return {
    action: "audit",
    plugin: entry.plugin || "unknown",
    kind: entry.kind,
    operation: entry.operation,
    ...(target ? { target } : {}),
  }
}

/** 判断规则是否需要填写目标。 */
export function needsTarget(entry: AuditEntry): boolean {
  return (
    (entry.kind === "process" && ["exec", "execSync"].includes(entry.operation)) ||
    /\[(?:redacted|path-redacted|truncated)\]/i.test(entry.target)
  )
}

/** 判断规则与事件的匹配关系，脱敏后无法判断时返回 unknown。 */
function relation(rule: Rule, entry: AuditEntry): boolean | "unknown" {
  const event = {
    plugin: entry.plugin,
    kind: entry.kind,
    operation: entry.operation,
    target: entry.target,
  }
  if (decide(event, [{ ...rule, target: undefined }]).ruleId !== rule.id) return false
  if (!rule.target || rule.target === "*") return true
  if (entry.target.includes("[path-redacted]")) {
    try {
      const origin = new URL(entry.target).origin
      const parts = rule.target.match(/^([a-z]+:\/\/[^/]+)(\/.*)?$/i)
      if (parts && !matchGlob(parts[1], origin)) return false
      if (parts?.[2] === "/*") return true
    } catch {}
    return "unknown"
  }
  if (needsTarget(entry)) return "unknown"
  return decide(event, [rule]).ruleId === rule.id
}

/** 统计规则在近期事件中的命中与生效数量。 */
export function matchingRules(rule: Rule, rules: Rule[], entries: AuditEntry[]) {
  return entries.flatMap(entry => {
    const own = relation(rule, entry)
    if (own === false) return []
    let first: string | undefined
    let uncertain = own === "unknown"
    for (const candidate of rules) {
      const match = relation(candidate, entry)
      if (match === false) continue
      if (match === "unknown") uncertain = true
      else first = candidate.id
      break
    }
    return [{ entry, first, uncertain }]
  })
}
