import { randomUUID } from "node:crypto"
import { performance } from "node:perf_hooks"
import { sha256 } from "../shared/hash.js"
import {
  decodeMediaBase64,
  imageMime,
  mediaArgument,
  mediaFail,
  mediaFrame,
  mediaHandle,
  mediaObject,
  mediaRequestId,
  nativeMediaLimits,
  parseImageOpen,
  parseMediaReply,
  type NativeImageOpen,
  type NativeImageTag,
  type NativeReplySegment,
} from "./media-protocol.js"

interface StoredImage extends NativeImageOpen {
  requestId: string
  expires: number
  bytes: Buffer
  received: number
  ready: boolean
}
interface RequestBudget {
  count: number
  bytes: number
  expires: number
}
export interface NativeMediaHostOptions {
  /** 仅当本会话仍持有当前请求的原 event.reply 能力时为 true。 */
  isActiveRequest(requestId: string): boolean
  now?: () => number
}
export type HostReplySegment =
  string | { type: "text"; text: string } | { type: "image"; file: Buffer }
export type HostReplyArguments = [
  HostReplySegment | HostReplySegment[],
  boolean,
  Record<string, never>,
]

/** 每会话的纯字节媒体代理，不打开路径或创建网络请求。 */
export class NativeMediaHost {
  private readonly images = new Map<string, StoredImage>()
  private readonly counts = new Map<string, RequestBudget>()
  private readonly sending = new Map<HostReplyArguments, number>()
  private readonly now: () => number
  private timer?: ReturnType<typeof setInterval>
  private reserved = 0
  private closed = false

  /** 创建工作进程侧的媒体存储。 */
  constructor(private readonly options: NativeMediaHostOptions) {
    this.now = options.now ?? (() => performance.now())
  }

  /** 媒体存储统计。 */
  get stats(): Readonly<{ images: number; bytes: number; requests: number }> {
    return Object.freeze({
      images: this.images.size,
      bytes: this.reserved,
      requests: this.counts.size,
    })
  }

  /** 校验请求是否仍有效。 */
  private active(requestId: unknown): string {
    if (this.closed) return mediaFail("MEDIA_CLOSED", "Media session is closed")
    const id = mediaRequestId(requestId)
    if (!this.options.isActiveRequest(id)) {
      this.releaseRequest(id)
      return mediaFail("MEDIA_EXPIRED_REQUEST", "Reply capability is missing or expired")
    }
    this.sweep()
    return id
  }

  /** 释放图片。 */
  private release(handle: string): void {
    const item = this.images.get(handle)
    if (!item) return
    this.images.delete(handle)
    this.reserved -= item.size
    if (!this.images.size && this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** 取得请求拥有的图片。 */
  private owned(requestId: string, handle: string, ready: boolean): StoredImage {
    const item = this.images.get(handle)
    if (!item || item.requestId !== requestId || item.ready !== ready)
      return mediaFail(
        "MEDIA_UNKNOWN_HANDLE",
        "Media capability is unknown, expired or belongs to another request",
      )
    return item
  }

  /** 清理过期图片。 */
  sweep(): void {
    const now = this.now()
    for (const [handle, item] of this.images) if (item.expires <= now) this.release(handle)
    for (const id of this.counts.keys()) {
      let active = false
      try {
        active = this.options.isActiveRequest(id)
      } catch {
        /* 查询失败时撤销能力。 */
      }
      if (!active) this.releaseRequest(id)
    }
  }

  /** 处理沙箱的媒体请求。 */
  receive(requestId: unknown, method: string, args: unknown): unknown {
    const id = this.active(requestId)
    const argument = mediaArgument(args)
    if (method === "open") {
      const input = parseImageOpen(argument)
      const budget = this.counts.get(id) ?? {
        count: 0,
        bytes: 0,
        expires: this.now() + nativeMediaLimits.lifetimeMs,
      }
      if (budget.expires <= this.now())
        return mediaFail("MEDIA_EXPIRED", "The request media deadline has expired")
      if (
        budget.count >= nativeMediaLimits.requestImages ||
        budget.bytes + input.size > nativeMediaLimits.requestBytes ||
        (!this.counts.has(id) && this.counts.size >= nativeMediaLimits.requests)
      )
        return mediaFail("MEDIA_REQUEST_LIMIT", "Media request limit exceeded")
      if (this.reserved + input.size > nativeMediaLimits.sessionBytes)
        return mediaFail("MEDIA_SESSION_LIMIT", "In-flight media exceeds 16 MiB")
      const handle = `upload-${randomUUID()}`
      const item: StoredImage = {
        ...input,
        requestId: id,
        expires: budget.expires,
        bytes: Buffer.alloc(input.size),
        received: 0,
        ready: false,
      }
      this.images.set(handle, item)
      this.counts.set(id, {
        count: budget.count + 1,
        bytes: budget.bytes + input.size,
        expires: budget.expires,
      })
      this.reserved += input.size
      if (!this.timer) {
        this.timer = setInterval(() => this.sweep(), 1000)
        this.timer.unref()
      }
      return { handle }
    }
    if (method === "abort") {
      const input = mediaObject(argument, ["handle"])
      const handle = mediaHandle(input.handle)
      const item = this.images.get(handle)
      if (item && item.requestId !== id)
        return mediaFail("MEDIA_UNKNOWN_HANDLE", "Media capability belongs to another request")
      this.release(handle)
      return null
    }
    if (method !== "chunk" && method !== "finish")
      return mediaFail("MEDIA_UNKNOWN_METHOD", "Unknown media service method")
    const input = mediaObject(
      argument,
      method === "chunk" ? ["handle", "offset", "data"] : ["handle"],
    )
    const handle = mediaHandle(input.handle, "upload")
    const item = this.owned(id, handle, false)
    try {
      if (method === "chunk") {
        if (!Number.isSafeInteger(input.offset) || input.offset !== item.received)
          return mediaFail("MEDIA_INVALID_OFFSET", "Media chunks must be contiguous and ordered")
        const bytes = decodeMediaBase64(input.data, nativeMediaLimits.chunkBytes)
        mediaFrame([input])
        if (item.received + bytes.length > item.size)
          return mediaFail("MEDIA_SIZE_LIMIT", "Media chunks exceed declared size")
        bytes.copy(item.bytes, item.received)
        item.received += bytes.length
        return { received: item.received }
      }
      if (item.received !== item.size)
        return mediaFail("MEDIA_INCOMPLETE", "Media upload is incomplete")
      if (sha256(item.bytes) !== item.sha256)
        return mediaFail("MEDIA_DIGEST_MISMATCH", "Media digest did not match")
      if (imageMime(item.bytes) !== item.mime)
        return mediaFail("MEDIA_TYPE_MISMATCH", "Image signature differs from declared type")
      const imageHandle = `image-${randomUUID()}`
      this.images.delete(handle)
      item.ready = true
      this.images.set(imageHandle, item)
      return { $type: "NativeImage", handle: imageHandle } satisfies NativeImageTag
    } catch (error) {
      this.release(handle)
      throw error
    }
  }

  /** 先校验整条回复，再在宿主发送前将每张图片消费一次。 */
  consumeReply(requestId: unknown, args: unknown): HostReplyArguments {
    const id = this.active(requestId)
    const [message, quote, options] = parseMediaReply(args)
    const used = new Set<string>()
    const convert = (segment: NativeReplySegment): HostReplySegment => {
      if (typeof segment === "string" || "type" in segment) return segment
      const item = this.owned(id, segment.handle, true)
      if (used.has(segment.handle))
        return mediaFail("MEDIA_REPLAY", "An image capability can be used only once")
      used.add(segment.handle)
      return { type: "image", file: item.bytes }
    }
    const output = Array.isArray(message) ? message.map(convert) : convert(message)
    let bytes = 0
    for (const handle of used) {
      bytes += this.images.get(handle)!.size
      this.images.delete(handle)
    }
    if (!this.images.size && this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    const reply: HostReplyArguments = [output, quote, options]
    // 已消费的能力不能重放；较慢 SDK 持有字节期间仍占用配额。
    if (bytes) this.sending.set(reply, bytes)
    return reply
  }

  /** 宿主在 SDK 回复的 finally 中调用，并传入原返回数组。 */
  releaseReply(reply: HostReplyArguments): void {
    const bytes = this.sending.get(reply)
    if (bytes === undefined) return
    this.sending.delete(reply)
    this.reserved -= bytes
  }

  /** 释放请求关联的全部图片。 */
  releaseRequest(requestId: string): void {
    for (const [handle, item] of this.images) if (item.requestId === requestId) this.release(handle)
    this.counts.delete(requestId)
  }

  /** 关闭存储并释放全部图片。 */
  close(): void {
    this.closed = true
    for (const handle of this.images.keys()) this.release(handle)
    this.counts.clear()
    // 已开始的宿主发送在自身 finally 调用 releaseReply 前持续占用配额。
    // 请求结束或会话关闭不能提前返还该内存预算。
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
