import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { adapterDto } from "../adapter/protocol.js";
import { sha256 } from "../../shared/hash.js";
import { imageMime, mediaArgument, mediaFail, mediaFrame, mediaObject, mediaRequestId, nativeMediaLimits, } from "./protocol.js";
import { parseImageSource, sourceHandle, transformImageSourceArgs, } from "./source-protocol.js";
/** 仅持有宿主已有 Buffer 引用，此处不解析文件系统或网络来源。 */
export class NativeMediaSourceHost {
    options;
    sources = new Map();
    requests = new Set();
    now;
    timer;
    reserved = 0;
    closed = false;
    readTokens = nativeMediaLimits.chunkBytes * 4;
    lastRead;
    /** 创建工作进程侧的图片来源存储。 */
    constructor(options) {
        this.options = options;
        this.now = options.now ?? (() => performance.now());
        this.lastRead = this.now();
    }
    /** 来源存储统计。 */
    get stats() {
        return Object.freeze({
            sources: this.sources.size,
            bytes: this.reserved,
            requests: this.requests.size,
        });
    }
    /** 校验请求是否仍有效。 */
    active(requestId) {
        if (this.closed)
            return mediaFail("MEDIA_SOURCE_CLOSED", "Media source session is closed");
        this.sweep();
        if (requestId === undefined)
            return undefined;
        const id = mediaRequestId(requestId);
        if (!this.options.isActiveRequest(id)) {
            this.releaseRequest(id);
            return mediaFail("MEDIA_SOURCE_REQUEST", "Adapter request is missing or expired");
        }
        return id;
    }
    /** 释放图片来源。 */
    release(handle) {
        const source = this.sources.get(handle);
        if (!source)
            return;
        this.sources.delete(handle);
        this.reserved -= source.tag.size;
        if (!this.sources.size && this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
    /** 清理过期来源。 */
    sweep() {
        const now = this.now();
        for (const [handle, source] of this.sources)
            if (source.expires <= now &&
                (source.requestId === undefined || source.offset < source.tag.size))
                this.release(handle);
        for (const id of this.requests) {
            let active = false;
            try {
                active = this.options.isActiveRequest(id);
            }
            catch {
                /* 查询失败时撤销能力。 */
            }
            if (!active)
                this.releaseRequest(id);
        }
    }
    /** 保留 Buffer 或发布令牌前，先校验整个调用。 */
    serializeArgs(args) {
        this.active();
        const staged = [];
        let bytes = 0;
        const output = transformImageSourceArgs(args, (value, copy) => {
            if (!Buffer.isBuffer(value))
                return copy(value);
            if (!value.length || value.length > nativeMediaLimits.imageBytes)
                return mediaFail("MEDIA_SIZE_LIMIT", "Each source image must be at most 8 MiB");
            bytes += value.length;
            if (staged.length >= nativeMediaLimits.requestImages ||
                bytes > nativeMediaLimits.requestBytes)
                return mediaFail("MEDIA_REQUEST_LIMIT", "Source call exceeds four images or 16 MiB");
            const tag = {
                $type: "NativeImageSource",
                handle: `source-${randomUUID()}`,
                size: value.length,
                mime: imageMime(value),
                sha256: sha256(value),
            };
            staged.push({
                tag,
                bytes: value,
                expires: this.now() + nativeMediaLimits.lifetimeMs,
                offset: 0,
            });
            return tag;
        });
        const dto = adapterDto(output);
        if (this.reserved + bytes > nativeMediaLimits.sessionBytes ||
            this.sources.size + staged.length >
                nativeMediaLimits.requests * nativeMediaLimits.requestImages)
            return mediaFail("MEDIA_SESSION_LIMIT", "Retained source images exceed session limits");
        for (const source of staged)
            this.sources.set(source.tag.handle, source);
        this.reserved += bytes;
        if (staged.length && !this.timer) {
            this.timer = setInterval(() => this.sweep(), 1000);
            this.timer.unref();
        }
        return dto;
    }
    /** 从消息参数中提取图片来源。 */
    tags(args) {
        const tags = [];
        const seen = new Set();
        const dto = transformImageSourceArgs(args, (value, copy) => {
            if (!value || typeof value !== "object" || Buffer.isBuffer(value) || Array.isArray(value))
                return copy(value);
            const descriptor = Object.getOwnPropertyDescriptor(value, "$type");
            if (descriptor && !("value" in descriptor))
                return mediaFail("MEDIA_SOURCE_DTO", "Source tag cannot contain accessors");
            if (descriptor?.value !== "NativeImageSource")
                return copy(value);
            const tag = parseImageSource(value);
            if (seen.has(tag.handle))
                return mediaFail("MEDIA_SOURCE_REPLAY", "A source token cannot appear twice");
            seen.add(tag.handle);
            tags.push(tag);
            return tag;
        });
        adapterDto(dto);
        if (tags.length > nativeMediaLimits.requestImages)
            return mediaFail("MEDIA_REQUEST_LIMIT", "Source call exceeds four images");
        return tags;
    }
    /** 调用方须先登记待处理的适配器调用，再绑定并发送。 */
    bindRequest(requestId, args) {
        const id = this.active(mediaRequestId(requestId));
        if (this.requests.has(id))
            return mediaFail("MEDIA_SOURCE_REPLAY", "Adapter request already has source bindings");
        const tags = this.tags(args);
        if (!tags.length)
            return;
        if (this.requests.size >= nativeMediaLimits.requests)
            return mediaFail("MEDIA_REQUEST_LIMIT", "Too many source adapter requests");
        let bytes = 0;
        const records = tags.map(tag => {
            const source = this.sources.get(tag.handle);
            if (!source ||
                source.requestId !== undefined ||
                source.tag.size !== tag.size ||
                source.tag.mime !== tag.mime ||
                source.tag.sha256 !== tag.sha256)
                return mediaFail("MEDIA_SOURCE_HANDLE", "Unknown, modified or already-bound source token");
            bytes += tag.size;
            return source;
        });
        if (bytes > nativeMediaLimits.requestBytes)
            return mediaFail("MEDIA_REQUEST_LIMIT", "Source adapter request exceeds 16 MiB");
        const deadline = this.now() + nativeMediaLimits.lifetimeMs;
        for (const source of records) {
            source.requestId = id;
            source.expires = deadline;
        }
        this.requests.add(id);
    }
    /** 响应已绑定适配器请求的分块读取，缺少请求标识时拒绝访问未绑定令牌。 */
    receive(requestId, method, args) {
        const id = this.active(mediaRequestId(requestId));
        if (method !== "read")
            return mediaFail("MEDIA_SOURCE_METHOD", "Unknown media source service");
        const input = mediaObject(mediaArgument(args), ["handle", "offset"]);
        const handle = sourceHandle(input.handle);
        const source = this.sources.get(handle);
        if (!source || source.requestId !== id)
            return mediaFail("MEDIA_SOURCE_HANDLE", "Source token is not bound to this adapter request");
        if (!Number.isSafeInteger(input.offset) ||
            input.offset !== source.offset ||
            source.offset >= source.tag.size)
            return mediaFail("MEDIA_SOURCE_REPLAY", "Source chunks must be read exactly once and in order");
        if (source.bytes.length !== source.tag.size)
            return mediaFail("MEDIA_SOURCE_CHANGED", "Source Buffer size changed after preparation");
        const end = Math.min(source.offset + nativeMediaLimits.chunkBytes, source.tag.size);
        const now = this.now();
        this.readTokens = Math.min(nativeMediaLimits.chunkBytes * 4, this.readTokens +
            (Math.max(0, now - this.lastRead) * nativeMediaLimits.bytesPerSecond) / 1000);
        this.lastRead = now;
        if (this.readTokens < end - source.offset)
            return mediaFail("MEDIA_SOURCE_RATE", "Media source reads exceed the session rate limit");
        this.readTokens -= end - source.offset;
        const result = {
            offset: source.offset,
            data: source.bytes.subarray(source.offset, end).toString("base64"),
            done: end === source.tag.size,
        };
        mediaFrame(result);
        source.offset = end;
        return result;
    }
    /** bindRequest 前适配器校验或发送失败时调用，仅释放未绑定令牌。 */
    discardArgs(args) {
        for (const tag of this.tags(args)) {
            const source = this.sources.get(tag.handle);
            if (source && source.requestId === undefined)
                this.release(tag.handle);
        }
    }
    /** 释放请求关联的来源。 */
    releaseRequest(requestId) {
        for (const [handle, source] of this.sources)
            if (source.requestId === requestId)
                this.release(handle);
        this.requests.delete(requestId);
    }
    /** 关闭存储。 */
    close() {
        this.closed = true;
        this.sources.clear();
        this.requests.clear();
        this.reserved = 0;
        if (this.timer)
            clearInterval(this.timer);
        this.timer = undefined;
    }
}
//# sourceMappingURL=source-host.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../../protect/objects.js"
__guardRegisterExports("native-sandbox/media/source-host.ts", { NativeMediaSourceHost })
