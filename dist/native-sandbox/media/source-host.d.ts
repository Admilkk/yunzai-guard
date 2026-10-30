import { type AdapterValue } from "../adapter/protocol.js";
import { type NativeImageSourceChunk } from "./source-protocol.js";
export interface NativeMediaSourceHostOptions {
    /** 仅限本客户端待处理的适配器调用，不接受普通业务请求。 */
    isActiveRequest(requestId: string): boolean;
    now?: () => number;
}
/** 仅持有宿主已有 Buffer 引用，此处不解析文件系统或网络来源。 */
export declare class NativeMediaSourceHost {
    private readonly options;
    private readonly sources;
    private readonly requests;
    private readonly now;
    private timer?;
    private reserved;
    private closed;
    private readTokens;
    private lastRead;
    /** 创建工作进程侧的图片来源存储。 */
    constructor(options: NativeMediaSourceHostOptions);
    /** 来源存储统计。 */
    get stats(): Readonly<{
        sources: number;
        bytes: number;
        requests: number;
    }>;
    /** 校验请求是否仍有效。 */
    private active;
    /** 释放图片来源。 */
    private release;
    /** 清理过期来源。 */
    sweep(): void;
    /** 保留 Buffer 或发布令牌前，先校验整个调用。 */
    serializeArgs(args: unknown): AdapterValue[];
    /** 从消息参数中提取图片来源。 */
    private tags;
    /** 调用方须先登记待处理的适配器调用，再绑定并发送。 */
    bindRequest(requestId: string, args: unknown): void;
    /** 响应已绑定适配器请求的分块读取，缺少请求标识时拒绝访问未绑定令牌。 */
    receive(requestId: unknown, method: string, args: unknown): NativeImageSourceChunk;
    /** bindRequest 前适配器校验或发送失败时调用，仅释放未绑定令牌。 */
    discardArgs(args: unknown): void;
    /** 释放请求关联的来源。 */
    releaseRequest(requestId: string): void;
    /** 关闭存储。 */
    close(): void;
}
