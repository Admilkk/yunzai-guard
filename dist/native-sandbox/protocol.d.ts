export declare const maxFrameBytes: number;
export type Dto = null | boolean | number | string | Dto[] | {
    [key: string]: Dto;
};
export declare class ProtocolError extends Error {
    code: string;
    /** 创建带错误码的协议错误。 */
    constructor(code: string, message: string);
}
/** 活动对象、函数、getter 和携带自定义原型的实例不能跨越 IPC。 */
export declare function toDto(value: unknown, metadata?: boolean, seen?: Set<object>, depth?: number): Dto;
/** 把 DTO 还原为值。 */
export declare function fromDto(value: unknown, depth?: number): unknown;
export interface Channel {
    send(message: Record<string, unknown>): void;
    service(service: "redis" | "event" | "media" | "media-source" | "core", method: string, args: unknown[], requestId?: string): Promise<unknown>;
}
