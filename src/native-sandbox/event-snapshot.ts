import type { NativeBotEventValue } from "./bot-events/protocol.js"
import { M } from "../shared/messages.js"

type Row = Record<string, unknown>
// SDK 消息类除公开消息内容外，还携带 protobuf 和客户端内部数据。
// 仅投影这些自有值字段，不克隆 Bot 或账号对象。
const messageFields = new Set([
  "post_type",
  "message_type",
  "notice_type",
  "request_type",
  "sub_type",
  "self_id",
  "user_id",
  "group_id",
  "discuss_id",
  "target_id",
  "operator_id",
  "message_id",
  "time",
  "seq",
  "rand",
  "pktnum",
  "index",
  "div",
  "font",
  "block",
  "msg",
  "raw_message",
  "message",
  "sender",
  "group_name",
  "source",
  "anonymous",
  "at",
  "atBot",
  "atme",
  "atall",
  "img",
  "file",
  "isPrivate",
  "isGroup",
  "isMaster",
  "game",
  "isSr",
  "isGs",
  "only_reply_at",
  "hasAlias",
  "logText",
  "logFnc",
  "adapter_id",
  "adapter_name",
  "notice_id",
  "request_id",
  "flag",
  "duration",
])

/** 仅复制自有值数据；支持的 SDK 事件根对象使用明确的内容白名单。 */
export function snapshotEvent(event: Row | undefined, protectedObjects?: ReadonlySet<object>): Row {
  if (!event) return {}
  const seen = new Set<object>()
  let nodes = 0
  /** 递归复制为有界的可序列化快照。 */
  function copy(value: unknown, depth = 0): unknown {
    if (++nodes > 4096 || depth > 12 || typeof value === "function" || typeof value === "symbol")
      return undefined
    if (value === null || typeof value !== "object") return value
    if (protectedObjects?.has(value)) return undefined
    if (seen.has(value)) return undefined
    const plain =
      Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value))
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (!plain) {
      const type = descriptors.post_type
      if (
        depth !== 0 ||
        !type ||
        !("value" in type) ||
        !["message", "notice", "request"].includes(type.value)
      )
        return undefined
    }
    seen.add(value)
    try {
      if (Array.isArray(value)) {
        if (value.length > 4096) return undefined
        return Array.from({ length: value.length }, (_, index) => {
          const descriptor = descriptors[String(index)]
          return descriptor && "value" in descriptor
            ? (copy(descriptor.value, depth + 1) ?? null)
            : null
        })
      }
      const result: Row = Object.create(null)
      const type = descriptors.post_type
      const game = descriptors.game
      const coreGameFlags =
        depth === 0 &&
        type &&
        "value" in type &&
        type.value === "message" &&
        (!game || "value" in game)
      for (const [key, descriptor] of Object.entries(descriptors)) {
        // 核心加载器游戏标志是自有且不可枚举的 get/set 对；从自有游戏数据推导
        // 其值，缺失视为 undefined，不调用宿主 getter。
        if (
          coreGameFlags &&
          (key === "isSr" || key === "isGs") &&
          !descriptor.enumerable &&
          !descriptor.configurable &&
          typeof descriptor.get === "function" &&
          typeof descriptor.set === "function"
        ) {
          result[key] = game?.value === (key === "isSr" ? "sr" : "gs")
          continue
        }
        if (
          ["__proto__", "constructor", "prototype", "reply", "bot", "runtime"].includes(key) ||
          (!plain && !messageFields.has(key)) ||
          !("value" in descriptor) ||
          (!descriptor.enumerable && !(key === "isMaster" && typeof descriptor.value === "boolean"))
        )
          continue
        const item = copy(descriptor.value, depth + 1)
        if (item !== undefined) result[key] = item
      }
      return result
    } finally {
      seen.delete(value)
    }
  }
  const value = copy(event)
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(M.nativeSandbox.eventSnapshot)
  return value as Row
}

/** 仅首个参数可为支持的 SDK 消息，其他 SDK 对象留在宿主。 */
export function snapshotBotEventArguments(
  args: unknown[],
  event = "",
  options: { protectedObjects?: ReadonlySet<object>; botState?: { uin: (string | number)[] } } = {},
): NativeBotEventValue[] {
  return args.map((value, index) => {
    // 核心 online 会发出活动 Bot Proxy，connect 回调也可能包含活动账号。
    // 这些生命周期事件仅传公开标识，即使 Proxy 看似普通对象也不例外。
    if (
      index === 0 &&
      value &&
      typeof value === "object" &&
      /^(?:online|offline|connect|disconnect)(?:\.|$)/.test(event)
    )
      return { uin: [...(options.botState?.uin ?? [])] }
    if (index === 0 && value && typeof value === "object" && !Array.isArray(value)) {
      const type = Object.getOwnPropertyDescriptor(value, "post_type")
      if (type && "value" in type && ["message", "notice", "request"].includes(type.value))
        return snapshotEvent(value as Row, options.protectedObjects) as NativeBotEventValue
    }
    return (snapshotEvent({ value }, options.protectedObjects).value ?? null) as NativeBotEventValue
  })
}
