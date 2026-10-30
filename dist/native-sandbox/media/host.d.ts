export interface NativeMediaHostOptions {
    /** 仅当本会话仍持有当前请求的原 event.reply 能力时为 true。 */
    isActiveRequest(requestId: string): boolean;
    now?: () => number;
}
export type HostReplySegment = string | {
    type: "text";
    text: string;
} | {
    type: "image";
    file: Buffer;
};
export type HostReplyArguments = [
    HostReplySegment | HostReplySegment[],
    boolean,
    Record<string, never>
];
/** 每会话的纯字节媒体代理，不打开路径或创建网络请求。 */
export declare class NativeMediaHost {
    private readonly options;
    private readonly images;
    private readonly counts;
    private readonly sending;
    private readonly now;
    private timer?;
    private reserved;
    private closed;
    /** 创建工作进程侧的媒体存储。 */
    constructor(options: NativeMediaHostOptions);
    /** 媒体存储统计。 */
    get stats(): Readonly<{
        images: number;
        bytes: number;
        requests: number;
    }>;
    /** 校验请求是否仍有效。 */
    private active;
    /** 释放图片。 */
    private release;
    /** 取得请求拥有的图片。 */
    private owned;
    /** 清理过期图片。 */
    sweep(): void;
    /** 处理沙箱的媒体请求。 */
    receive(requestId: unknown, method: string, args: unknown): unknown;
    /** 先校验整条回复，再在宿主发送前将每张图片消费一次。 */
    consumeReply(requestId: unknown, args: unknown): HostReplyArguments;
    /** 宿主在 SDK 回复的 finally 中调用，并传入原返回数组。 */
    releaseReply(reply: HostReplyArguments): void;
    /** 释放请求关联的全部图片。 */
    releaseRequest(requestId: string): void;
    /** 关闭存储并释放全部图片。 */
    close(): void;
}
