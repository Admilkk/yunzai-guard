import { isMap, isSeq, parseDocument, type Document } from "yaml"
import { matchGlob } from "../../../src/config/policy.js"
import type { Draft, Rule } from "../types"

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function overlaps(a?: string, b?: string): boolean {
  if (!a || !b || matchGlob(a, b) || matchGlob(b, a)) return true
  if (!/[*?]/.test(a) || !/[*?]/.test(b)) return false
  const prefixA = a.split(/[*?]/)[0]
  const prefixB = b.split(/[*?]/)[0]
  if (!prefixA.startsWith(prefixB) && !prefixB.startsWith(prefixA)) return false
  const suffixA = a.slice(Math.max(a.lastIndexOf("*"), a.lastIndexOf("?")) + 1)
  const suffixB = b.slice(Math.max(b.lastIndexOf("*"), b.lastIndexOf("?")) + 1)
  if (!suffixA.endsWith(suffixB) && !suffixB.endsWith(suffixA)) return false
  const minimumA = a.replaceAll("*", "").length
  const minimumB = b.replaceAll("*", "").length
  return (
    Math.max(minimumA, minimumB) <=
    Math.min(a.includes("*") ? Infinity : minimumA, b.includes("*") ? Infinity : minimumB)
  )
}

/** 条件不完整时保守报告冲突，让用户选择，避免悄悄覆盖草稿。 */
export function rulesOverlap(a: Rule, b: Rule): boolean {
  const kinds = (rule: Rule) => (typeof rule.kind === "string" ? [rule.kind] : (rule.kind ?? ["*"]))
  return (
    overlaps(a.plugin, b.plugin) &&
    kinds(a).some(x => kinds(b).some(y => overlaps(x, y))) &&
    overlaps(a.operation, b.operation) &&
    overlaps(a.target, b.target)
  )
}

function changedRules(before: Rule[], after: Rule[]): Rule[] {
  const byId = new Map(before.map(rule => [rule.id, rule]))
  const changed = after.filter(rule => !same(byId.get(rule.id), rule))
  const ids = new Set(after.map(rule => rule.id))
  changed.push(...before.filter(rule => !ids.has(rule.id)))
  // 只比较共同规则的相对顺序，新增或删除规则不应让其他规则被误判为移动。
  const retainedBefore = before.filter(rule => ids.has(rule.id))
  const retainedAfter = after.filter(rule => byId.has(rule.id))
  changed.push(...retainedAfter.filter((rule, index) => retainedBefore[index]?.id !== rule.id))
  return [...new Map(changed.map(rule => [rule.id, rule])).values()]
}

export function draftConflicts(base: Draft, draft: Draft, next: Draft): Rule[] {
  const existing = changedRules(base.rules ?? [], draft.rules ?? [])
  const incoming = changedRules(draft.rules ?? [], next.rules ?? [])
  return existing.filter(rule => incoming.some(other => rulesOverlap(rule, other)))
}

/** 只退回用户选择替换的草稿规则，其他未保存字段保持原样。 */
export function resetConflictingRules(base: Draft, draft: Draft, conflicts: Rule[]): Draft {
  const result = structuredClone(draft)
  const ids = new Set(conflicts.map(rule => rule.id))
  // 移除后按原顺序插回，也恢复已移动规则的优先级；其他草稿规则保持相对顺序。
  result.rules = (result.rules ?? []).filter(rule => !ids.has(rule.id))
  const present = new Set(result.rules.map(rule => rule.id))
  const baseRules = base.rules ?? []
  for (let index = 0; index < baseRules.length; index++) {
    const rule = baseRules[index]
    if (!ids.has(rule.id) || present.has(rule.id)) continue
    const nextId = baseRules
      .slice(index + 1)
      .find(item => result.rules!.some(current => current.id === item.id))?.id
    const previousId = baseRules
      .slice(0, index)
      .reverse()
      .find(item => result.rules!.some(current => current.id === item.id))?.id
    const at = nextId
      ? result.rules.findIndex(item => item.id === nextId)
      : previousId
        ? result.rules.findIndex(item => item.id === previousId) + 1
        : result.rules.length
    result.rules.splice(at, 0, structuredClone(rule))
    present.add(rule.id)
  }
  return result
}

/** 快捷操作只修改 rules；原始配置编辑中也保留其他字段与 YAML 注释。 */
export function mergeRawRules(raw: string, rules: Rule[]): string {
  const document: Document = parseDocument(raw, { uniqueKeys: true })
  if (document.errors.length) throw new Error(document.errors[0].message)
  if (document.contents === null) {
    document.contents = document.createNode({})
    document.commentBefore ??= document.comment
    document.comment = null
  }
  if (!isMap(document.contents)) throw new Error("配置顶层必须是键值对象")
  const previous = document.get("rules", true)
  const nodes = new Map(
    isSeq(previous) ? previous.items.filter(isMap).map(node => [String(node.get("id")), node]) : [],
  )
  const sequence = isSeq(previous) ? previous : document.createNode([])
  if (!isSeq(sequence)) throw new Error("规则格式错误")
  sequence.items = rules.map(rule => {
    const node = nodes.get(rule.id)
    if (!node) return document.createNode(rule)
    const value = node.toJSON() as Record<string, unknown>
    for (const key of Object.keys(value)) if (!Object.hasOwn(rule, key)) node.delete(key)
    for (const [key, item] of Object.entries(rule)) if (!same(value[key], item)) node.set(key, item)
    return node
  })
  document.set("rules", sequence)
  return document.toString()
}
