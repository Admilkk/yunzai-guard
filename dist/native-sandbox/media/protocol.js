export const nativeMediaLimits = Object.freeze({
    imageBytes: 8 * 1024 * 1024,
    sessionBytes: 16 * 1024 * 1024,
    chunkBytes: 32 * 1024,
    frameBytes: 64 * 1024,
    requestImages: 4,
    requestBytes: 16 * 1024 * 1024,
    bytesPerSecond: 512 * 1024,
    requests: 64,
    segments: 64,
    textCharacters: 32000,
    lifetimeMs: 45000,
    fetchTimeoutMs: 10000,
});
export class NativeMediaError extends Error {
    code;
    /** 创建带错误码的媒体协议错误。 */
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** 抛出媒体协议错误。 */
export function mediaFail(code, message) {
    throw new NativeMediaError(code, message);
}
/** 校验对象字段。 */
export function mediaObject(value, allowed) {
    if (!value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        return mediaFail("MEDIA_INVALID_DTO", "Expected a plain media object");
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== "string" ||
            !allowed.includes(key) ||
            !descriptor.enumerable ||
            !("value" in descriptor))
            return mediaFail("MEDIA_INVALID_DTO", "Unexpected media field or accessor");
    }
    return value;
}
/** 校验数组长度。 */
export function mediaArray(value, max) {
    if (!Array.isArray(value) || value.length > max)
        return mediaFail("MEDIA_INVALID_DTO", "Expected a bounded media array");
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor))
            return mediaFail("MEDIA_INVALID_DTO", "Media arrays cannot contain holes or accessors");
    }
    if (Reflect.ownKeys(value).some(key => key !== "length" &&
        (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)))
        return mediaFail("MEDIA_INVALID_DTO", "Unexpected media array property");
    return value;
}
/** 校验请求 id。 */
export function mediaRequestId(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
        return mediaFail("MEDIA_INVALID_REQUEST", "Invalid media request identity");
    return value;
}
/** 校验媒体句柄。 */
export function mediaHandle(value, kind) {
    if (typeof value !== "string" ||
        !/^(upload|image)-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value) ||
        (kind && !value.startsWith(`${kind}-`)))
        return mediaFail("MEDIA_INVALID_HANDLE", "Invalid media capability handle");
    return value;
}
/** 校验媒体帧。 */
export function mediaFrame(value) {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > nativeMediaLimits.frameBytes)
        mediaFail("MEDIA_FRAME_LIMIT", "Media frame exceeds 64 KiB");
}
/** 取出单个参数对象。 */
export function mediaArgument(args) {
    const items = mediaArray(args, 1);
    if (items.length !== 1)
        return mediaFail("MEDIA_INVALID_DTO", "Media service expects one argument");
    // 每个方法先校验自身允许的精确字段集，再检查值。
    return items[0];
}
/** 解析图片打开请求。 */
export function parseImageOpen(value) {
    const item = mediaObject(value, ["size", "mime", "sha256"]);
    if (!Number.isSafeInteger(item.size) ||
        Number(item.size) < 1 ||
        Number(item.size) > nativeMediaLimits.imageBytes)
        return mediaFail("MEDIA_SIZE_LIMIT", "Each image must contain 1 byte to 8 MiB");
    if (typeof item.mime !== "string" ||
        !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(item.mime))
        return mediaFail("MEDIA_UNSUPPORTED_TYPE", "Only PNG, JPEG, GIF and WebP images are supported");
    if (typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256))
        return mediaFail("MEDIA_INVALID_DIGEST", "Expected a SHA-256 digest");
    return { size: Number(item.size), mime: item.mime, sha256: item.sha256 };
}
/** 解析图片标签。 */
export function parseImageTag(value) {
    const item = mediaObject(value, ["$type", "handle"]);
    if (item.$type !== "NativeImage")
        return mediaFail("MEDIA_INVALID_TAG", "Expected an image capability tag");
    return { $type: "NativeImage", handle: mediaHandle(item.handle, "image") };
}
/** 解码有大小上限的 base64。 */
export function decodeMediaBase64(value, maxBytes) {
    if (typeof value !== "string" ||
        value.length > 4 * Math.ceil(maxBytes / 3) ||
        value.length % 4 !== 0 ||
        /[^A-Za-z0-9+/=]/.test(value))
        return mediaFail("MEDIA_INVALID_BASE64", "Expected bounded canonical base64 bytes");
    const bytes = Buffer.from(value, "base64");
    if (!bytes.length || bytes.length > maxBytes || bytes.toString("base64") !== value)
        return mediaFail("MEDIA_SIZE_LIMIT", "Invalid decoded media size");
    return bytes;
}
/** 仅检查固定长度文件头，宿主不调用图片解码器。 */
export function imageMime(bytes) {
    const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (input.length >= 24 &&
        input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        input.toString("ascii", 12, 16) === "IHDR" &&
        input.readUInt32BE(16) > 0 &&
        input.readUInt32BE(20) > 0)
        return "image/png";
    if (input.length >= 4 &&
        input[0] === 255 &&
        input[1] === 216 &&
        input[2] === 255 &&
        input[input.length - 2] === 255 &&
        input[input.length - 1] === 217)
        return "image/jpeg";
    if (input.length >= 10 &&
        ["GIF87a", "GIF89a"].includes(input.toString("ascii", 0, 6)) &&
        input.readUInt16LE(6) > 0 &&
        input.readUInt16LE(8) > 0)
        return "image/gif";
    if (input.length >= 16 &&
        input.toString("ascii", 0, 4) === "RIFF" &&
        input.toString("ascii", 8, 12) === "WEBP" &&
        ["VP8 ", "VP8L", "VP8X"].includes(input.toString("ascii", 12, 16)) &&
        input.readUInt32LE(4) === input.length - 8)
        return "image/webp";
    return mediaFail("MEDIA_UNSUPPORTED_TYPE", "Image bytes have an unsupported or invalid signature");
}
/** 宿主不接受路径、URL、Buffer JSON 或任意消息段类型。 */
export function parseMediaReply(args) {
    const input = mediaArray(args, 3);
    if (!input.length)
        return mediaFail("MEDIA_INVALID_REPLY", "A reply message is required");
    let textSize = 0, images = 0;
    const segment = (value) => {
        if (typeof value === "string") {
            textSize += value.length;
            return value;
        }
        const item = mediaObject(value, ["type", "text", "$type", "handle"]);
        if (item.type === "text") {
            mediaObject(item, ["type", "text"]);
            if (typeof item.text !== "string")
                return mediaFail("MEDIA_INVALID_REPLY", "Text segments need text");
            textSize += item.text.length;
            return { type: "text", text: item.text };
        }
        images++;
        return parseImageTag(item);
    };
    const message = Array.isArray(input[0])
        ? mediaArray(input[0], nativeMediaLimits.segments).map(segment)
        : segment(input[0]);
    if (textSize > nativeMediaLimits.textCharacters || images > nativeMediaLimits.requestImages)
        return mediaFail("MEDIA_REPLY_LIMIT", "Reply text or image count exceeds its limit");
    if (input[1] !== undefined && input[1] !== null && typeof input[1] !== "boolean")
        return mediaFail("MEDIA_INVALID_REPLY", "Reply quote must be boolean");
    if (input[2] !== undefined && input[2] !== null)
        mediaObject(input[2], []);
    const reply = [message, input[1] === true, {}];
    mediaFrame(reply);
    return reply;
}
//# sourceMappingURL=protocol.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../../protect/objects.js"
__guardRegisterExports("native-sandbox/media/protocol.ts", { nativeMediaLimits, NativeMediaError, mediaFail, mediaObject, mediaArray, mediaRequestId, mediaHandle, mediaFrame, mediaArgument, parseImageOpen, parseImageTag, decodeMediaBase64, imageMime, parseMediaReply })
