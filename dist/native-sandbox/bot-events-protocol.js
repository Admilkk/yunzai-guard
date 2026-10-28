export const nativeBotEventLimits = Object.freeze({
    sessionListeners: 128,
    emitterListeners: 1024,
    pendingDeliveries: 128,
    // once 投递失败的记录保留至 off/clear，不能静默丢弃待清理状态。
    retiredOnce: 256,
    eventNameLength: 256,
    argumentCount: 16,
    argumentBytes: 64 * 1024,
});
export class NativeBotEventBridgeError extends Error {
    code;
    /** 创建带错误码的事件协议错误。 */
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** 抛出事件协议错误。 */
export function botEventFail(code, message) {
    throw new NativeBotEventBridgeError(code, message);
}
/** 校验会话 id。 */
export function botEventSessionId(input) {
    if (typeof input !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input))
        return botEventFail("BOT_EVENT_INVALID_SESSION", "Invalid Bot event session identifier");
    return input;
}
/** 校验事件名。 */
export function botEventName(input) {
    if (typeof input !== "string" ||
        !input.length ||
        input.length > nativeBotEventLimits.eventNameLength ||
        /[\x00-\x1f\x7f]/.test(input))
        return botEventFail("BOT_EVENT_INVALID_NAME", "Bot event names must be bounded strings");
    return input;
}
/** 校验序号。 */
function sequence(input) {
    if (typeof input !== "number" || !Number.isSafeInteger(input) || input <= 0)
        return botEventFail("BOT_EVENT_INVALID_SEQUENCE", "Invalid Bot event sequence");
    return input;
}
/** 生成监听句柄。 */
export function botEventHandle(sessionId, index) {
    return `bot-event-${botEventSessionId(sessionId)}:${sequence(index)}`;
}
/** 解析并校验监听句柄。 */
export function parseBotEventHandle(input, sessionId) {
    const prefix = `bot-event-${botEventSessionId(sessionId)}:`;
    if (typeof input !== "string" || !input.startsWith(prefix))
        return botEventFail("BOT_EVENT_FOREIGN_HANDLE", "Bot event handle belongs to another session");
    const suffix = input.slice(prefix.length);
    if (!/^[1-9][0-9]{0,15}$/.test(suffix) || String(sequence(Number(suffix))) !== suffix)
        return botEventFail("BOT_EVENT_INVALID_HANDLE", "Invalid Bot event handle");
    return input;
}
/** 校验为普通对象。 */
function record(input) {
    if (!input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
        return botEventFail("BOT_EVENT_INVALID_FRAME", "Expected a plain Bot event frame");
    const result = Object.create(null);
    for (const key of Reflect.ownKeys(input)) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor))
            return botEventFail("BOT_EVENT_INVALID_FRAME", "Bot event frames cannot contain accessors");
        result[key] = descriptor.value;
    }
    return result;
}
/** IPC 两端在修改各自账本前独立校验控制帧。 */
export function parseBotEventFrame(input) {
    const row = record(input);
    const allowed = ["type", "sessionId", "sequence"];
    if (row.type === "subscribe")
        allowed.push("id", "event", "once");
    else if (row.type === "unsubscribe")
        allowed.push("id");
    else if (row.type === "clear")
        allowed.push("event");
    else
        return botEventFail("BOT_EVENT_INVALID_FRAME", "Unknown Bot event frame type");
    if (Object.keys(row).some(key => !allowed.includes(key)))
        return botEventFail("BOT_EVENT_INVALID_FRAME", "Unknown Bot event frame field");
    const sessionId = botEventSessionId(row.sessionId), index = sequence(row.sequence);
    if (row.type === "subscribe") {
        const id = parseBotEventHandle(row.id, sessionId);
        if (id !== botEventHandle(sessionId, index) || typeof row.once !== "boolean")
            return botEventFail("BOT_EVENT_INVALID_FRAME", "Invalid Bot subscription identity");
        return {
            type: "subscribe",
            sessionId,
            sequence: index,
            id,
            event: botEventName(row.event),
            once: row.once,
        };
    }
    if (row.type === "unsubscribe")
        return {
            type: "unsubscribe",
            sessionId,
            sequence: index,
            id: parseBotEventHandle(row.id, sessionId),
        };
    return {
        type: "clear",
        sessionId,
        sequence: index,
        ...(Object.hasOwn(row, "event") ? { event: botEventName(row.event) } : {}),
    };
}
/** 边界默认只传值，集成方可先将活动事件投影为 DTO。 */
export function parseBotEventArguments(input) {
    if (!Array.isArray(input) || input.length > nativeBotEventLimits.argumentCount)
        return botEventFail("BOT_EVENT_INVALID_DTO", "Bot event arguments exceed their bound");
    const seen = new Set();
    let nodes = 0;
    const copy = (value, depth) => {
        if (++nodes > 4096 || depth > 16)
            return botEventFail("BOT_EVENT_INVALID_DTO", "Bot event DTO is too large or deep");
        if (value === null || value === undefined)
            return null;
        if (typeof value === "boolean")
            return value;
        if (typeof value === "string" && value.length <= nativeBotEventLimits.argumentBytes)
            return value;
        if (typeof value === "number" && Number.isFinite(value))
            return value;
        if (typeof value !== "object" || !value)
            return botEventFail("BOT_EVENT_INVALID_DTO", "Bot event DTO contains a non-value");
        const prototype = Object.getPrototypeOf(value);
        if (seen.has(value) ||
            !(Array.isArray(value)
                ? [Array.prototype, null].includes(prototype)
                : [Object.prototype, null].includes(prototype)))
            return botEventFail("BOT_EVENT_INVALID_DTO", "Bot event DTO contains a cycle or SDK instance");
        seen.add(value);
        try {
            const descriptors = Object.getOwnPropertyDescriptors(value);
            if (Array.isArray(value)) {
                if (value.length > 4096 || Reflect.ownKeys(value).length !== value.length + 1)
                    return botEventFail("BOT_EVENT_INVALID_DTO", "Bot event DTO requires dense value arrays");
                return Array.from({ length: value.length }, (_, index) => {
                    const descriptor = descriptors[String(index)];
                    if (!descriptor?.enumerable || !("value" in descriptor))
                        return botEventFail("BOT_EVENT_INVALID_DTO", "Bot event DTO cannot contain accessors");
                    return copy(descriptor.value, depth + 1);
                });
            }
            const result = Object.create(null);
            for (const key of Reflect.ownKeys(value)) {
                const descriptor = typeof key === "string" ? descriptors[key] : undefined;
                if (!descriptor?.enumerable ||
                    !("value" in descriptor) ||
                    ["__proto__", "constructor", "prototype"].includes(key))
                    return botEventFail("BOT_EVENT_INVALID_DTO", "Unsafe Bot event DTO property");
                result[key] = copy(descriptor.value, depth + 1);
            }
            return result;
        }
        finally {
            seen.delete(value);
        }
    };
    const result = copy(input, 0);
    if (Buffer.byteLength(JSON.stringify(result)) > nativeBotEventLimits.argumentBytes)
        return botEventFail("BOT_EVENT_FRAME_LIMIT", "Bot event DTO exceeds 64 KiB");
    return result;
}
//# sourceMappingURL=bot-events-protocol.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("native-sandbox/bot-events-protocol.ts", { nativeBotEventLimits, NativeBotEventBridgeError, botEventFail, botEventSessionId, botEventName, botEventHandle, parseBotEventHandle, parseBotEventFrame, parseBotEventArguments })
