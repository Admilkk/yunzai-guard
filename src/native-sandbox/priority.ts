import { M } from "../shared/messages.js"
export interface NativePriorityTag {
  $type: "NativePriority"
  value: "positive-infinity" | "negative-infinity"
}

/** Infinity 可用于加载器排序元数据，不能作为普通 JSON 数字。 */
export function encodeNativePriority(value: unknown): number | NativePriorityTag {
  if (typeof value !== "number" || Number.isNaN(value)) throw new Error(M.nativeSandbox.priority)
  if (Number.isFinite(value)) return value
  return { $type: "NativePriority", value: value > 0 ? "positive-infinity" : "negative-infinity" }
}

/** 解析插件优先级。 */
export function parseNativePriority(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(value)
    if (
      keys.length === 2 &&
      keys.every(
        key =>
          typeof key === "string" &&
          ["$type", "value"].includes(key) &&
          descriptors[key]?.enumerable &&
          "value" in descriptors[key],
      ) &&
      descriptors.$type?.value === "NativePriority"
    ) {
      if (descriptors.value?.value === "positive-infinity") return Infinity
      if (descriptors.value?.value === "negative-infinity") return -Infinity
    }
  }
  throw new Error(M.nativeSandbox.priorityMetadata)
}
