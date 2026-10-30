export type NativeBotEventValue = null | boolean | number | string | NativeBotEventValue[] | {
    [key: string]: NativeBotEventValue;
};
export type NativeBotEventFrame = {
    type: "subscribe";
    sessionId: string;
    sequence: number;
    id: string;
    event: string;
    once: boolean;
} | {
    type: "unsubscribe";
    sessionId: string;
    sequence: number;
    id: string;
} | {
    type: "clear";
    sessionId: string;
    sequence: number;
    event?: string;
};
export declare const nativeBotEventLimits: Readonly<{
    sessionListeners: 128;
    emitterListeners: 1024;
    pendingDeliveries: 128;
    retiredOnce: 256;
    eventNameLength: 256;
    argumentCount: 16;
    argumentBytes: number;
}>;
export declare class NativeBotEventBridgeError extends Error {
    readonly code: string;
    /** 创建带错误码的事件协议错误。 */
    constructor(code: string, message: string);
}
/** 抛出事件协议错误。 */
export declare function botEventFail(code: string, message: string): never;
/** 校验会话 id。 */
export declare function botEventSessionId(input: unknown): string;
/** 校验事件名。 */
export declare function botEventName(input: unknown): string;
/** 生成监听句柄。 */
export declare function botEventHandle(sessionId: string, index: number): string;
/** 解析并校验监听句柄。 */
export declare function parseBotEventHandle(input: unknown, sessionId: string): string;
/** IPC 两端在修改各自账本前独立校验控制帧。 */
export declare function parseBotEventFrame(input: unknown): NativeBotEventFrame;
/** 边界默认只传值，集成方可先将活动事件投影为 DTO。 */
export declare function parseBotEventArguments(input: unknown): NativeBotEventValue[];
