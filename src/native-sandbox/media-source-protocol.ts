import {
  mediaArray,
  mediaFail,
  mediaObject,
  nativeMediaLimits,
  parseImageOpen,
  type NativeImageOpen,
} from "./media-protocol.js"

export interface NativeImageSource extends NativeImageOpen {
  $type: "NativeImageSource"
  handle: string
}
export interface NativeImageSourceChunk {
  offset: number
  data: string
  done: boolean
}

/** 校验来源句柄。 */
export function sourceHandle(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^source-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value)
  )
    return mediaFail("MEDIA_SOURCE_HANDLE", "Invalid media source handle")
  return value
}

/** 解析图片来源。 */
export function parseImageSource(value: unknown): NativeImageSource {
  const item = mediaObject(value, ["$type", "handle", "size", "mime", "sha256"])
  if (item.$type !== "NativeImageSource")
    return mediaFail("MEDIA_SOURCE_TAG", "Invalid media source tag")
  return {
    $type: "NativeImageSource",
    handle: sourceHandle(item.handle),
    ...parseImageOpen({ size: item.size, mime: item.mime, sha256: item.sha256 }),
  }
}

/** 共用的有界 DTO 遍历，仅 image.file 特殊转换，其余值保持 JSON。 */
export function transformImageSourceArgs(
  args: unknown,
  imageFile: (value: unknown, copy: (value: unknown) => unknown) => unknown,
): unknown[] {
  const seen = new Set<object>()
  let nodes = 0
  let payloadBytes = 0
  const charge = (bytes: number): void => {
    payloadBytes += bytes
    if (payloadBytes > nativeMediaLimits.frameBytes)
      mediaFail("MEDIA_SOURCE_DTO", "Source arguments exceed the payload size limit")
  }
  // 在 adapterDto 最终 JSON 序列化前限制输入；转义可能增加字节，
  // 因此有界遍历后仍以精确帧检查为准。
  const text = (value: string): string => {
    if (value.length > nativeMediaLimits.frameBytes - payloadBytes - 2)
      return mediaFail("MEDIA_SOURCE_DTO", "Source text exceeds the payload size limit")
    charge(Buffer.byteLength(value, "utf8") + 2)
    return value
  }
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 8192 || depth > 16)
      return mediaFail("MEDIA_SOURCE_DTO", "Source arguments exceed depth or item limits")
    if (value === null || value === undefined) {
      charge(4)
      return null
    }
    if (typeof value === "boolean") {
      charge(value ? 4 : 5)
      return value
    }
    if (typeof value === "string") return text(value)
    if (typeof value === "number" && Number.isFinite(value)) {
      charge(String(value).length)
      return value
    }
    if (!value || typeof value !== "object" || Buffer.isBuffer(value))
      return mediaFail("MEDIA_SOURCE_DTO", "Only image.file may contain an existing Buffer")
    if (seen.has(value)) return mediaFail("MEDIA_SOURCE_DTO", "Cyclic source arguments")
    seen.add(value)
    try {
      if (Array.isArray(value)) {
        const items = mediaArray(value, 2048)
        charge(2 + Math.max(0, items.length - 1))
        return items.map(item => copy(item, depth + 1))
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        return mediaFail("MEDIA_SOURCE_DTO", "Source arguments must contain plain JSON objects")
      const keys = Reflect.ownKeys(value)
      if (keys.length > 8192 - nodes)
        return mediaFail("MEDIA_SOURCE_DTO", "Source arguments exceed the item limit")
      charge(2 + Math.max(0, keys.length - 1))
      const descriptors = Object.getOwnPropertyDescriptors(value)
      for (const key of keys) {
        const entry = descriptors[key as string]
        if (
          typeof key !== "string" ||
          ["__proto__", "constructor", "prototype"].includes(key) ||
          !entry?.enumerable ||
          !("value" in entry)
        )
          return mediaFail(
            "MEDIA_SOURCE_DTO",
            "Source arguments contain an unsafe field or accessor",
          )
        text(key)
        charge(1)
      }
      if (descriptors.$type?.value === "NativeImageSource")
        return mediaFail(
          "MEDIA_SOURCE_LOCATION",
          "Media source tags are allowed only in image.file",
        )
      const result: Record<string, unknown> = Object.create(null)
      for (const [key, entry] of Object.entries(descriptors))
        result[key] =
          key === "file" && descriptors.type?.value === "image"
            ? imageFile(entry.value, item => copy(item, depth + 1))
            : copy(entry.value, depth + 1)
      return result
    } finally {
      seen.delete(value)
    }
  }
  const items = mediaArray(args, 16)
  charge(2 + Math.max(0, items.length - 1))
  return items.map(item => copy(item, 0))
}
