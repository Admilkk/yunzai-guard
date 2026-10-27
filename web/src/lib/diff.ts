import type { Draft } from "../types"

export interface ConfigChange {
  path: string
  before?: unknown
  after?: unknown
  invalid?: boolean
  limited?: boolean
}

const comparisonLimit = Symbol("comparison-limit")
const maxDepth = 32
const maxNodes = 500000
const maxChanges = 5000
const previewLength = 240

/** 判断为普通对象。 */
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

/** 递归比较两份文档，收集变化路径。 */
function compare(
  before: unknown,
  after: unknown,
  path: string,
  changes: ConfigChange[],
  budget: { nodes: number },
  depth = 0,
) {
  if (--budget.nodes < 0 || depth > maxDepth || changes.length >= maxChanges) throw comparisonLimit
  if (Object.is(before, after)) return
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length)
    for (let index = 0; index < length; index++) {
      if (--budget.nodes < 0 || changes.length >= maxChanges) throw comparisonLimit
      const next = `${path}[${index}]`
      if (index >= before.length) changes.push({ path: next, after: after[index] })
      else if (index >= after.length) changes.push({ path: next, before: before[index] })
      else compare(before[index], after[index], next, changes, budget, depth + 1)
    }
    return
  }
  if (object(before) && object(after)) {
    const beforeKeys = Object.keys(before)
    const afterKeys = Object.keys(after)
    if (beforeKeys.length + afterKeys.length > budget.nodes) throw comparisonLimit
    const keys = [...new Set([...beforeKeys, ...afterKeys])].sort()
    for (const key of keys) {
      if (--budget.nodes < 0 || changes.length >= maxChanges) throw comparisonLimit
      const next = path ? `${path}.${key}` : key
      if (!Object.hasOwn(before, key)) changes.push({ path: next, after: after[key] })
      else if (!Object.hasOwn(after, key)) changes.push({ path: next, before: before[key] })
      else compare(before[key], after[key], next, changes, budget, depth + 1)
    }
    return
  }
  changes.push({ path: path || "settings.json", before, after })
}

/** 列出草稿相对当前配置的变化。 */
export function documentChanges(
  server: Draft,
  draft: Draft,
  rawText: string | null,
): ConfigChange[] {
  let after: unknown = draft
  if (rawText !== null) {
    try {
      after = JSON.parse(rawText)
    } catch {
      return [
        {
          path: "settings.json",
          before: server,
          after: rawText,
          invalid: true,
        },
      ]
    }
  }
  const changes: ConfigChange[] = []
  try {
    compare(server, after, "", changes, { nodes: maxNodes })
  } catch (error) {
    if (error !== comparisonLimit) throw error
    return [{ path: "settings.json", before: server, after, limited: true }]
  }
  return changes
}

/** 生成有界的值预览。 */
function preview(value: unknown, budget: { nodes: number }, depth = 0): unknown {
  if (--budget.nodes < 0 || depth > 6) return "…"
  if (typeof value === "string")
    return value.length > previewLength ? `${value.slice(0, previewLength)}…` : value
  if (value === null || typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) {
    const result: unknown[] = []
    for (let index = 0; index < value.length; index++) {
      if (index >= 16 || budget.nodes <= 0) {
        result.push("…")
        break
      }
      result.push(preview(value[index], budget, depth + 1))
    }
    return result
  }
  if (object(value)) {
    const result: Record<string, unknown> = Object.create(null)
    let count = 0
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue
      if (++count > 16 || budget.nodes <= 0) {
        result["…"] = "…"
        break
      }
      result[key.slice(0, 80)] = preview(value[key], budget, depth + 1)
    }
    return result
  }
  return value === undefined ? "未设置" : `[${typeof value}]`
}

/** 把变化值格式化为短文本。 */
export function formatChange(value: unknown): string {
  if (value === undefined) return "未设置"
  const text =
    typeof value === "string"
      ? value.slice(0, previewLength + 1)
      : JSON.stringify(preview(value, { nodes: 128 }))
  return text.length > previewLength ? `${text.slice(0, previewLength)}…` : text
}
