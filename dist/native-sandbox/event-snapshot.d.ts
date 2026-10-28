import type { NativeBotEventValue } from "./bot-events-protocol.js";
type Row = Record<string, unknown>;
/** 仅复制自有值数据；支持的 SDK 事件根对象使用明确的内容白名单。 */
export declare function snapshotEvent(event: Row | undefined, protectedObjects?: ReadonlySet<object>): Row;
/** 仅首个参数可为支持的 SDK 消息，其他 SDK 对象留在宿主。 */
export declare function snapshotBotEventArguments(args: unknown[], event?: string, options?: {
    protectedObjects?: ReadonlySet<object>;
    botState?: {
        uin: (string | number)[];
    };
}): NativeBotEventValue[];
export {};
