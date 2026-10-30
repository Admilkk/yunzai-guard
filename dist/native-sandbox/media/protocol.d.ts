export declare const nativeMediaLimits: Readonly<{
    imageBytes: number;
    sessionBytes: number;
    chunkBytes: number;
    frameBytes: number;
    requestImages: 4;
    requestBytes: number;
    bytesPerSecond: number;
    requests: 64;
    segments: 64;
    textCharacters: 32000;
    lifetimeMs: 45000;
    fetchTimeoutMs: 10000;
}>;
export type NativeImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export type NativeMediaMethod = "open" | "chunk" | "finish" | "abort";
export interface NativeImageTag {
    $type: "NativeImage";
    handle: string;
}
export type NativeReplySegment = string | {
    type: "text";
    text: string;
} | NativeImageTag;
export type NativeReplyArguments = [
    NativeReplySegment | NativeReplySegment[],
    boolean,
    Record<string, never>
];
export interface NativeImageOpen {
    size: number;
    mime: NativeImageMime;
    sha256: string;
}
export interface NativeImageChunk {
    handle: string;
    offset: number;
    data: string;
}
export declare class NativeMediaError extends Error {
    code: string;
    /** 创建带错误码的媒体协议错误。 */
    constructor(code: string, message: string);
}
/** 抛出媒体协议错误。 */
export declare function mediaFail(code: string, message: string): never;
/** 校验对象字段。 */
export declare function mediaObject(value: unknown, allowed: readonly string[]): Record<string, unknown>;
/** 校验数组长度。 */
export declare function mediaArray(value: unknown, max: number): unknown[];
/** 校验请求 id。 */
export declare function mediaRequestId(value: unknown): string;
/** 校验媒体句柄。 */
export declare function mediaHandle(value: unknown, kind?: "upload" | "image"): string;
/** 校验媒体帧。 */
export declare function mediaFrame(value: unknown): void;
/** 取出单个参数对象。 */
export declare function mediaArgument(args: unknown): Record<string, unknown>;
/** 解析图片打开请求。 */
export declare function parseImageOpen(value: unknown): NativeImageOpen;
/** 解析图片标签。 */
export declare function parseImageTag(value: unknown): NativeImageTag;
/** 解码有大小上限的 base64。 */
export declare function decodeMediaBase64(value: unknown, maxBytes: number): Buffer;
/** 仅检查固定长度文件头，宿主不调用图片解码器。 */
export declare function imageMime(bytes: Uint8Array): NativeImageMime;
/** 宿主不接受路径、URL、Buffer JSON 或任意消息段类型。 */
export declare function parseMediaReply(args: unknown): NativeReplyArguments;
