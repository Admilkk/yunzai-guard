import { type NativeMediaMethod, type NativeReplyArguments } from "./protocol.js";
export type NativeMediaService = (service: "media", method: NativeMediaMethod, args: unknown[], requestId: string) => Promise<unknown>;
export interface NativeMediaGuestOptions {
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
}
/** 将原文字或图片 e.reply 参数转为有界字节上传和不透明标记。 */
export declare class NativeMediaGuest {
    private readonly service;
    private readonly now;
    private readonly sleep;
    private nextChunkAt;
    private queue;
    /** 创建沙箱内的媒体代理。 */
    constructor(service: NativeMediaService, options?: NativeMediaGuestOptions);
    /** 每个插件会话共用一个队列，防止并发回复叠加上传速率。 */
    private chunk;
    /** 把图片上传给宿主，返回图片标签。 */
    private upload;
    /** 把回复参数中的图片替换为宿主标签。 */
    prepareReply(requestId: string, args: unknown[]): Promise<NativeReplyArguments>;
}
