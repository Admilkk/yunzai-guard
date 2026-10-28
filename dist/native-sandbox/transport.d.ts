import type { ChildProcess } from "node:child_process";
import type { Duplex } from "node:stream";
export declare const maxTransportFrameBytes: number;
type IngressKind = "frame" | "bytes" | "log" | "diagnostic" | "hook" | "task" | "adapter" | "behavior" | "bot-events";
/** 每会话令牌桶允许启动突发，不放任宿主工作量，也不设置生命周期累计限额。 */
export declare class NativeIngressBudget {
    private readonly now;
    private stopped;
    private readonly buckets;
    /** 创建入站配额计数器。 */
    constructor(now?: () => number);
    /** 是否已因超额封闭。 */
    get sealed(): boolean;
    /** 消耗指定类型的配额，超额时封闭。 */
    consume(kind: IngressKind, amount?: number): void;
}
/** 原生 Node JSON IPC 以换行分帧，解码或 JSON.parse 前先限制字节数。 */
export declare class BoundedJsonLines {
    private readonly message;
    private readonly failure;
    private readonly limit;
    private readonly budget;
    private pending;
    private pendingBytes;
    private failed;
    private readonly decoder;
    /** 创建按行解析的帧读取器。 */
    constructor(message: (value: unknown) => void, failure: (error: Error) => void, limit?: number, budget?: NativeIngressBudget);
    /** 以错误中止读取。 */
    private abort;
    /** 写入一段数据并解析完整帧。 */
    write(chunk: Buffer): void;
    /** 结束读取，残留数据视为错误。 */
    end(): void;
}
/** 仅父进程使用，FD 3 为普通管道，避免 Node 代为解析无界子进程 IPC。 */
export declare function attachNativeTransport(child: ChildProcess, stream: Duplex, failure: (error: Error) => void): void;
export {};
