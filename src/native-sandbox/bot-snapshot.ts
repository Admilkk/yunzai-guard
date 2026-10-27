import { object, keys } from "../config/validation.js"
import { adapterId, type AdapterId } from "./adapter-protocol.js"
import { M } from "../shared/messages.js"

export interface NativeBotSnapshot {
  uin: AdapterId[]
}

/** 账号标识只是值元数据，不代表以对应账号发送消息的权限。 */
function identifiers(source: unknown, decorated = false): AdapterId[] {
  if (!Array.isArray(source) || source.length > 256)
    throw new Error(M.nativeSandbox.botSnapshotLimit)
  const descriptors = Object.getOwnPropertyDescriptors(source)
  if (!decorated && Reflect.ownKeys(source).length !== source.length + 1)
    throw new Error(M.nativeSandbox.botSnapshotDense)
  return Array.from({ length: source.length }, (_, index) => {
    const descriptor = descriptors[String(index)]
    if (!descriptor?.enumerable || !("value" in descriptor))
      throw new Error(M.nativeSandbox.botSnapshotAccessor)
    return adapterId(descriptor.value)
  })
}

/** 解析并校验 Bot 快照。 */
export function parseNativeBotSnapshot(input: unknown): NativeBotSnapshot {
  const value = object(input, "native Bot snapshot")
  keys(value, ["uin"], "native Bot snapshot")
  return { uin: identifiers(value.uin) }
}

/** 不序列化 Bot、uin.toJSON 方法、活动 SDK 或账号对象。 */
export function snapshotNativeBot(bot: unknown): NativeBotSnapshot {
  const ids = bot && typeof bot === "object" ? Reflect.get(bot, "uin") : undefined
  return { uin: identifiers(ids === undefined ? [] : ids, true) }
}
