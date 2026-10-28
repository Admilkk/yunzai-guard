import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { adapterDto } from "./adapter-protocol.js";
import { decodeMediaBase64, imageMime, mediaFail, mediaObject, mediaRequestId, nativeMediaLimits, } from "./media-protocol.js";
import { parseImageSource, transformImageSourceArgs, } from "./media-source-protocol.js";
/** 仅在适配器自身的插件进程中还原父进程签发的 image.file 标记。 */
export class NativeMediaSourceGuest {
    service;
    now;
    sleep;
    queue = Promise.resolve();
    nextReadAt = 0;
    /** 创建沙箱内的图片来源代理。 */
    constructor(service, options = {}) {
        this.service = service;
        this.now = options.now ?? (() => performance.now());
        this.sleep =
            options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    }
    /** 分块读取宿主图片。 */
    read(requestId, source, offset, deadline) {
        const job = this.queue.then(async () => {
            const delay = this.nextReadAt - this.now();
            if (delay > 0)
                await this.sleep(Math.ceil(delay));
            if (this.now() >= deadline)
                return mediaFail("MEDIA_SOURCE_EXPIRED", "Source read deadline expired");
            const size = Math.min(nativeMediaLimits.chunkBytes, source.size - offset);
            this.nextReadAt =
                Math.max(this.nextReadAt, this.now()) + (size * 1000) / nativeMediaLimits.bytesPerSecond;
            return this.service("media-source", "read", [{ handle: source.handle, offset }], requestId);
        });
        this.queue = job.then(() => undefined, () => undefined);
        return job;
    }
    /** 把参数中的图片标签还原为图片数据。 */
    async restoreArgs(requestId, args) {
        const id = mediaRequestId(requestId);
        const deadline = this.now() + nativeMediaLimits.lifetimeMs;
        const sources = new Map();
        let size = 0;
        const prepared = transformImageSourceArgs(args, (value, copy) => {
            if (!value || typeof value !== "object" || Array.isArray(value) || Buffer.isBuffer(value))
                return copy(value);
            const descriptor = Object.getOwnPropertyDescriptor(value, "$type");
            if (descriptor && !("value" in descriptor))
                return mediaFail("MEDIA_SOURCE_DTO", "Source tag cannot contain accessors");
            if (descriptor?.value !== "NativeImageSource")
                return copy(value);
            const source = parseImageSource(value);
            if (sources.has(source.handle))
                return mediaFail("MEDIA_SOURCE_REPLAY", "A source token cannot appear twice");
            size += source.size;
            if (sources.size >= nativeMediaLimits.requestImages || size > nativeMediaLimits.requestBytes)
                return mediaFail("MEDIA_REQUEST_LIMIT", "Adapter source images exceed request limits");
            sources.set(source.handle, source);
            return source;
        });
        adapterDto(prepared);
        const restored = new Map();
        for (const source of sources.values()) {
            const bytes = Buffer.alloc(source.size);
            let offset = 0;
            while (offset < bytes.length) {
                const result = mediaObject(await this.read(id, source, offset, deadline), [
                    "offset",
                    "data",
                    "done",
                ]);
                const chunk = decodeMediaBase64(result.data, nativeMediaLimits.chunkBytes);
                const expected = Math.min(nativeMediaLimits.chunkBytes, bytes.length - offset);
                if (this.now() >= deadline ||
                    result.offset !== offset ||
                    chunk.length !== expected ||
                    result.done !== (offset + expected === bytes.length))
                    return mediaFail("MEDIA_SOURCE_CHUNK", "Source response has incorrect offset, length, completion or deadline");
                chunk.copy(bytes, offset);
                offset += chunk.length;
            }
            if (createHash("sha256").update(bytes).digest("hex") !== source.sha256)
                return mediaFail("MEDIA_DIGEST_MISMATCH", "Source image digest did not match");
            if (imageMime(bytes) !== source.mime)
                return mediaFail("MEDIA_TYPE_MISMATCH", "Source image signature did not match");
            restored.set(source.handle, bytes);
        }
        return transformImageSourceArgs(prepared, (value, copy) => {
            if (value &&
                typeof value === "object" &&
                !Array.isArray(value) &&
                Object.getOwnPropertyDescriptor(value, "$type")?.value === "NativeImageSource")
                return restored.get(parseImageSource(value).handle);
            return copy(value);
        });
    }
}
//# sourceMappingURL=media-source-guest.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("native-sandbox/media-source-guest.ts", { NativeMediaSourceGuest })
