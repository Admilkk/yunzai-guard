import { M } from "../shared/messages.js"
export const maxFrameBytes = 64 * 1024
export type Dto = null | boolean | number | string | Dto[] | { [key: string]: Dto }
export class ProtocolError extends Error {
  /** 创建带错误码的协议错误。 */
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

/** 活动对象、函数、getter 和携带自定义原型的实例不能跨越 IPC。 */
export function toDto(value: unknown, metadata = false, seen = new Set<object>(), depth = 0): Dto {
  const unsupported = (message: string): never => {
    throw new ProtocolError(metadata ? "UNSUPPORTED_METADATA" : "UNSUPPORTED_DTO", message)
  }
  if (depth > 20) return unsupported("DTO exceeds maximum depth")
  if (value === undefined || value === null) return null
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return unsupported("Non-finite numbers cannot cross IPC")
    return value
  }
  if (typeof value !== "object") return unsupported(`Cannot transfer ${typeof value}`)
  if (value instanceof RegExp) return { $type: "RegExp", source: value.source, flags: value.flags }
  if (value instanceof Error)
    return { $type: "Error", name: value.name, message: value.message, stack: value.stack ?? "" }
  if (seen.has(value)) return unsupported("Cyclic objects cannot cross IPC")
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return unsupported("Only JSON objects and RegExp tags can cross IPC")
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map(item => toDto(item, metadata, seen, depth + 1))
    const result: Record<string, Dto> = Object.create(null)
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (!Object.hasOwn(descriptor, "value")) return unsupported("Accessors cannot cross IPC")
      if (key === "__proto__" || key === "constructor" || key === "prototype")
        return unsupported("Unsafe DTO property")
      result[key] = toDto(descriptor.value, metadata, seen, depth + 1)
    }
    return result
  } finally {
    seen.delete(value)
  }
}

/** 把 DTO 还原为值。 */
export function fromDto(value: unknown, depth = 0): unknown {
  const dto = toDto(value)
  const decode = (item: Dto, level: number): unknown => {
    if (level > 20) throw new ProtocolError("INVALID_DTO", M.nativeSandbox.dtoDepth)
    if (item === null || typeof item !== "object") return item
    if (Array.isArray(item)) return item.map(child => decode(child, level + 1))
    if (item.$type === "RegExp") {
      if (typeof item.source !== "string" || typeof item.flags !== "string")
        throw new ProtocolError("INVALID_DTO", M.nativeSandbox.regexpTag)
      return new RegExp(item.source, item.flags)
    }
    return Object.fromEntries(
      Object.entries(item).map(([key, child]) => [key, decode(child, level + 1)]),
    )
  }
  return decode(dto, depth)
}

export interface Channel {
  send(message: Record<string, unknown>): void
  service(
    service: "redis" | "event" | "media" | "media-source" | "core",
    method: string,
    args: unknown[],
    requestId?: string,
  ): Promise<unknown>
}
