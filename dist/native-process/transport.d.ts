import type { NativeIdentityOptions } from "./protocol.js";
import type { ObjectValue } from "./validation.js";
export declare class Transport {
    readonly deadline: number;
    readonly nonce: string;
    private readonly child;
    private buffer;
    private stderrBytes;
    private sequence;
    private broken?;
    private pending?;
    private tail;
    private normalClosing;
    private closePromise?;
    private exited;
    private exitCode;
    private exitSignal;
    private readonly exitPromise;
    private readonly failureWaiters;
    /** 启动原生身份辅助程序并建立请求通道。 */
    constructor(options: NativeIdentityOptions, deadline: number);
    /** 标记通道损坏并拒绝后续请求。 */
    private break;
    /** 发送命令并等待匹配的回复。 */
    request(command: string, extra?: ObjectValue): Promise<ObjectValue>;
    /** 校验回复的类型与字段。 */
    assertReply(item: ObjectValue, type: string, required: string[], optional?: string[]): void;
    /** 以状态无效原因断开通道。 */
    invalidate(): void;
    /** 执行校验，失败时断开通道并抛出。 */
    validate<T>(check: () => T): T;
    /** 关闭通道，重复调用返回同一个 Promise。 */
    close(): Promise<void>;
    /** 执行实际关闭并等待辅助程序退出。 */
    private closeOnce;
}
