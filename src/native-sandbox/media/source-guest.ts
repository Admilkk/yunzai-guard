import { createHash } from "node:crypto"
import { performance } from "node:perf_hooks"
import { adapterDto } from "../adapter/protocol.js"
import {
  decodeMediaBase64,
  imageMime,
  mediaFail,
  mediaObject,
  mediaRequestId,
  nativeMediaLimits,
} from "./protocol.js"
import {
  parseImageSource,
  transformImageSourceArgs,
  type NativeImageSource,
} from "./source-protocol.js"
import type { NativeMediaGuestOptions } from "./guest.js"

export type NativeMediaSourceService = (
  service: "media-source",
  method: "read",
  args: unknown[],
  requestId: string,
) => Promise<unknown>

/** 仅在适配器自身的插件进程中还原父进程签发的 image.file 标记。 */
export class NativeMediaSourceGuest {
  private readonly now: () => number
  private readonly sleep: (milliseconds: number) => Promise<void>
  private queue: Promise<unknown> = Promise.resolve()
  private nextReadAt = 0

  /** 创建沙箱内的图片来源代理。 */
  constructor(
    private readonly service: NativeMediaSourceService,
    options: NativeMediaGuestOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now())
    this.sleep =
      options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  }

  /** 分块读取宿主图片。 */
  private read(
    requestId: string,
    source: NativeImageSource,
    offset: number,
    deadline: number,
  ): Promise<unknown> {
    const job = this.queue.then(async () => {
      const delay = this.nextReadAt - this.now()
      if (delay > 0) await this.sleep(Math.ceil(delay))
      if (this.now() >= deadline)
        return mediaFail("MEDIA_SOURCE_EXPIRED", "Source read deadline expired")
      const size = Math.min(nativeMediaLimits.chunkBytes, source.size - offset)
      this.nextReadAt =
        Math.max(this.nextReadAt, this.now()) + (size * 1000) / nativeMediaLimits.bytesPerSecond
      return this.service("media-source", "read", [{ handle: source.handle, offset }], requestId)
    })
    this.queue = job.then(
      () => undefined,
      () => undefined,
    )
    return job
  }

  /** 把参数中的图片标签还原为图片数据。 */
  async restoreArgs(requestId: string, args: unknown): Promise<unknown[]> {
    const id = mediaRequestId(requestId)
    const deadline = this.now() + nativeMediaLimits.lifetimeMs
    const sources = new Map<string, NativeImageSource>()
    let size = 0
    const prepared = transformImageSourceArgs(args, (value, copy) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || Buffer.isBuffer(value))
        return copy(value)
      const descriptor = Object.getOwnPropertyDescriptor(value, "$type")
      if (descriptor && !("value" in descriptor))
        return mediaFail("MEDIA_SOURCE_DTO", "Source tag cannot contain accessors")
      if (descriptor?.value !== "NativeImageSource") return copy(value)
      const source = parseImageSource(value)
      if (sources.has(source.handle))
        return mediaFail("MEDIA_SOURCE_REPLAY", "A source token cannot appear twice")
      size += source.size
      if (sources.size >= nativeMediaLimits.requestImages || size > nativeMediaLimits.requestBytes)
        return mediaFail("MEDIA_REQUEST_LIMIT", "Adapter source images exceed request limits")
      sources.set(source.handle, source)
      return source
    })
    adapterDto(prepared)
    const restored = new Map<string, Buffer>()
    for (const source of sources.values()) {
      const bytes = Buffer.alloc(source.size)
      let offset = 0
      while (offset < bytes.length) {
        const result = mediaObject(await this.read(id, source, offset, deadline), [
          "offset",
          "data",
          "done",
        ])
        const chunk = decodeMediaBase64(result.data, nativeMediaLimits.chunkBytes)
        const expected = Math.min(nativeMediaLimits.chunkBytes, bytes.length - offset)
        if (
          this.now() >= deadline ||
          result.offset !== offset ||
          chunk.length !== expected ||
          result.done !== (offset + expected === bytes.length)
        )
          return mediaFail(
            "MEDIA_SOURCE_CHUNK",
            "Source response has incorrect offset, length, completion or deadline",
          )
        chunk.copy(bytes, offset)
        offset += chunk.length
      }
      if (createHash("sha256").update(bytes).digest("hex") !== source.sha256)
        return mediaFail("MEDIA_DIGEST_MISMATCH", "Source image digest did not match")
      if (imageMime(bytes) !== source.mime)
        return mediaFail("MEDIA_TYPE_MISMATCH", "Source image signature did not match")
      restored.set(source.handle, bytes)
    }
    return transformImageSourceArgs(prepared, (value, copy) => {
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.getOwnPropertyDescriptor(value, "$type")?.value === "NativeImageSource"
      )
        return restored.get(parseImageSource(value).handle)!
      return copy(value)
    })
  }
}
