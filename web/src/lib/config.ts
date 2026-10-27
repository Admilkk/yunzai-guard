import type { Draft } from "../types"

/** 把草稿合并到当前配置上，得到完整文档。 */
export function mergedDocument(document: Draft, active: Draft): Draft {
  const base = structuredClone(active)
  const merge = (target: Record<string, any>, patch: Record<string, any>) => {
    for (const [key, value] of Object.entries(patch)) {
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.hasOwn(target, key) &&
        target[key] &&
        typeof target[key] === "object" &&
        !Array.isArray(target[key])
      )
        merge(target[key], value)
      else
        Object.defineProperty(target, key, {
          value: structuredClone(value),
          enumerable: true,
          writable: true,
          configurable: true,
        })
    }
    return target
  }
  if (document.pluginSandbox?.defaults)
    for (const key of ["timeoutMs", "memoryMiB", "violationAction", "hookAction"])
      delete base.pluginSandbox?.[key]
  return merge(base, document)
}
