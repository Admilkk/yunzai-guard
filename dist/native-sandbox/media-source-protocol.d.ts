import { type NativeImageOpen } from "./media-protocol.js";
export interface NativeImageSource extends NativeImageOpen {
    $type: "NativeImageSource";
    handle: string;
}
export interface NativeImageSourceChunk {
    offset: number;
    data: string;
    done: boolean;
}
/** 校验来源句柄。 */
export declare function sourceHandle(value: unknown): string;
/** 解析图片来源。 */
export declare function parseImageSource(value: unknown): NativeImageSource;
/** 共用的有界 DTO 遍历，仅 image.file 特殊转换，其余值保持 JSON。 */
export declare function transformImageSourceArgs(args: unknown, imageFile: (value: unknown, copy: (value: unknown) => unknown) => unknown): unknown[];
