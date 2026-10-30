import type { NativeMediaGuestOptions } from "./guest.js";
export type NativeMediaSourceService = (service: "media-source", method: "read", args: unknown[], requestId: string) => Promise<unknown>;
/** 仅在适配器自身的插件进程中还原父进程签发的 image.file 标记。 */
export declare class NativeMediaSourceGuest {
    private readonly service;
    private readonly now;
    private readonly sleep;
    private queue;
    private nextReadAt;
    /** 创建沙箱内的图片来源代理。 */
    constructor(service: NativeMediaSourceService, options?: NativeMediaGuestOptions);
    /** 分块读取宿主图片。 */
    private read;
    /** 把参数中的图片标签还原为图片数据。 */
    restoreArgs(requestId: string, args: unknown): Promise<unknown[]>;
}
