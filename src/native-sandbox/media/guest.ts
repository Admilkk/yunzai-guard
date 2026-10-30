import fs from "node:fs/promises"
import { constants } from "node:fs"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { performance } from "node:perf_hooks"
import {
  decodeMediaBase64,
  imageMime,
  mediaArray,
  mediaFail,
  mediaFrame,
  mediaHandle,
  mediaObject,
  mediaRequestId,
  nativeMediaLimits,
  parseImageTag,
  parseMediaReply,
  type NativeImageTag,
  type NativeMediaMethod,
  type NativeReplyArguments,
  type NativeReplySegment,
} from "./protocol.js"

export type NativeMediaService = (
  service: "media",
  method: NativeMediaMethod,
  args: unknown[],
  requestId: string,
) => Promise<unknown>

export interface NativeMediaGuestOptions {
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

/** 仅在已隔离的插件进程解析来源，并遵循其文件与网络权限。 */
async function imageBytes(source: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(source)) {
    if (!source.length || source.length > nativeMediaLimits.imageBytes)
      return mediaFail("MEDIA_SIZE_LIMIT", "Image exceeds 8 MiB")
    return Buffer.from(source)
  }
  const input = source instanceof URL ? source.href : source
  if (typeof input !== "string" || !input.length || input.includes("\0"))
    return mediaFail(
      "MEDIA_INVALID_SOURCE",
      "Image needs Buffer, base64, a local file or HTTP(S) URL",
    )
  if (input.startsWith("base64://"))
    return decodeMediaBase64(input.slice(9), nativeMediaLimits.imageBytes)
  if (input.length > 8192) return mediaFail("MEDIA_INVALID_SOURCE", "Image source is too long")
  if (/^https?:\/\//i.test(input)) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), nativeMediaLimits.fetchTimeoutMs)
    timer.unref()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      // 不能在监控包装前保存 fetch，也不能请求宿主抓取此 URL。
      const response = await globalThis.fetch(input, { signal: controller.signal })
      if (!response.ok || !response.body)
        return mediaFail("MEDIA_FETCH_FAILED", "Guest image fetch failed")
      const declared = response.headers.get("content-length")
      if (
        declared !== null &&
        (!/^\d+$/.test(declared) || Number(declared) > nativeMediaLimits.imageBytes)
      )
        return mediaFail("MEDIA_SIZE_LIMIT", "Downloaded image exceeds 8 MiB")
      reader = response.body.getReader()
      let size = 0
      const chunks: Uint8Array[] = []
      while (true) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.length
        if (size > nativeMediaLimits.imageBytes)
          return mediaFail("MEDIA_SIZE_LIMIT", "Downloaded image exceeds 8 MiB")
        chunks.push(part.value)
      }
      if (!size) return mediaFail("MEDIA_SIZE_LIMIT", "Image is empty")
      return Buffer.concat(chunks, size)
    } finally {
      clearTimeout(timer)
      controller.abort()
      await reader?.cancel().catch(() => {})
    }
  }
  let filename = input
  if (/^file:/i.test(input)) {
    const url = new URL(input)
    if (url.search || url.hash)
      return mediaFail("MEDIA_INVALID_SOURCE", "File URLs cannot contain query or fragment")
    filename = fileURLToPath(url)
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(input) && !/^[A-Za-z]:[\\/]/.test(input))
    return mediaFail("MEDIA_UNSUPPORTED_TYPE", "Image URL protocol is unsupported")
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size < 1 || stat.size > nativeMediaLimits.imageBytes)
      return mediaFail("MEDIA_SIZE_LIMIT", "Image source must be a regular file of at most 8 MiB")
    const bytes = Buffer.alloc(stat.size)
    let position = 0
    while (position < bytes.length) {
      const part = await file.read(bytes, position, bytes.length - position, position)
      if (!part.bytesRead)
        return mediaFail("MEDIA_SOURCE_CHANGED", "Image file changed while reading")
      position += part.bytesRead
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, position)).bytesRead)
      return mediaFail("MEDIA_SOURCE_CHANGED", "Image file changed while reading")
    return bytes
  } finally {
    await file.close()
  }
}

/** 将原文字或图片 e.reply 参数转为有界字节上传和不透明标记。 */
export class NativeMediaGuest {
  private readonly now: () => number
  private readonly sleep: (milliseconds: number) => Promise<void>
  private nextChunkAt = 0
  private queue: Promise<unknown> = Promise.resolve()

  /** 创建沙箱内的媒体代理。 */
  constructor(
    private readonly service: NativeMediaService,
    options: NativeMediaGuestOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now())
    this.sleep =
      options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  }

  /** 每个插件会话共用一个队列，防止并发回复叠加上传速率。 */
  private chunk(
    requestId: string,
    handle: string,
    offset: number,
    bytes: Buffer,
  ): Promise<unknown> {
    const job = this.queue.then(async () => {
      const wait = this.nextChunkAt - this.now()
      if (wait > 0) await this.sleep(Math.ceil(wait))
      this.nextChunkAt =
        Math.max(this.now(), this.nextChunkAt) +
        (bytes.length * 1000) / nativeMediaLimits.bytesPerSecond
      const args = [{ handle, offset, data: bytes.toString("base64") }]
      mediaFrame(args)
      return this.service("media", "chunk", args, requestId)
    })
    this.queue = job.then(
      () => undefined,
      () => undefined,
    )
    return job
  }

  /** 把图片上传给宿主，返回图片标签。 */
  private async upload(requestId: string, source: unknown): Promise<NativeImageTag> {
    const bytes = await imageBytes(source)
    const mime = imageMime(bytes)
    const digest = createHash("sha256").update(bytes).digest("hex")
    const opened = mediaObject(
      await this.service(
        "media",
        "open",
        [{ size: bytes.length, mime, sha256: digest }],
        requestId,
      ),
      ["handle"],
    )
    const handle = mediaHandle(opened.handle, "upload")
    try {
      for (let offset = 0; offset < bytes.length; offset += nativeMediaLimits.chunkBytes) {
        const chunk = bytes.subarray(offset, offset + nativeMediaLimits.chunkBytes)
        const result = mediaObject(await this.chunk(requestId, handle, offset, chunk), ["received"])
        if (result.received !== offset + chunk.length)
          return mediaFail("MEDIA_INVALID_ACK", "Media receiver acknowledged an unexpected offset")
      }
      return parseImageTag(await this.service("media", "finish", [{ handle }], requestId))
    } catch (error) {
      await this.service("media", "abort", [{ handle }], requestId).catch(() => {})
      throw error
    }
  }

  /** 把回复参数中的图片替换为宿主标签。 */
  async prepareReply(requestId: string, args: unknown[]): Promise<NativeReplyArguments> {
    const id = mediaRequestId(requestId)
    const input = mediaArray(args, 3)
    if (!input.length) return mediaFail("MEDIA_INVALID_REPLY", "A reply message is required")
    const segments = Array.isArray(input[0])
      ? mediaArray(input[0], nativeMediaLimits.segments)
      : [input[0]]
    const sources: { position: number; source: unknown }[] = []
    const values: NativeReplySegment[] = []
    // 读取文件或消费媒体能力前，先校验全部参数。
    for (const value of segments) {
      if (typeof value === "string") {
        values.push(value)
        continue
      }
      const item = mediaObject(value, ["type", "text", "file", "name"])
      if (item.type === "text") {
        mediaObject(item, ["type", "text"])
        if (typeof item.text !== "string")
          return mediaFail("MEDIA_INVALID_REPLY", "Text segments need text")
        values.push({ type: "text", text: item.text })
      } else if (item.type === "image") {
        mediaObject(item, ["type", "file", "name"])
        if (item.name !== undefined && item.name !== null)
          return mediaFail("MEDIA_UNSUPPORTED_OPTION", "Named image options are not exposed")
        if (sources.length >= nativeMediaLimits.requestImages)
          return mediaFail("MEDIA_REQUEST_LIMIT", "A reply supports at most four images")
        sources.push({ position: values.length, source: item.file })
        values.push("")
      } else
        return mediaFail("MEDIA_UNSUPPORTED_TYPE", "Reply supports only text and image segments")
    }
    parseMediaReply([Array.isArray(input[0]) ? values : values[0], input[1], input[2]])
    const uploaded: NativeImageTag[] = []
    try {
      for (const source of sources) {
        const tag = await this.upload(id, source.source)
        uploaded.push(tag)
        values[source.position] = tag
      }
      return parseMediaReply([Array.isArray(input[0]) ? values : values[0], input[1], input[2]])
    } catch (error) {
      for (const tag of uploaded)
        await this.service("media", "abort", [{ handle: tag.handle }], id).catch(() => {})
      throw error
    }
  }
}
