export const adapterAccountMethods = [
    "login",
    "logout",
    "getFriendArray",
    "getFriendList",
    "getFriendMap",
    "getGroupArray",
    "getGroupList",
    "getGroupMap",
    "getGroupMemberMap",
];
export const adapterEntityMethods = ["sendMsg", "recallMsg", "getInfo", "getAvatarUrl"];
export const adapterProfileKeys = [
    "id",
    "uin",
    "user_id",
    "group_id",
    "nickname",
    "name",
    "username",
    "user_name",
    "group_name",
    "card",
    "avatar",
    "sex",
    "age",
    "title",
    "role",
    "level",
    "join_time",
    "last_sent_time",
    "member_count",
    "max_member_count",
    "first_name",
    "last_name",
];
const metadataKeys = new Set([...adapterProfileKeys, "info", "version", "stat"]);
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
export const reservedAdapterIds = new Set([
    ...forbidden,
    "then",
    "bot",
    "bots",
    "adapter",
    "uin",
    "em",
    "emit",
    "on",
    "once",
    "off",
    "addListener",
    "removeListener",
    "removeAllListeners",
    "listeners",
    "rawListeners",
    "exit",
    "restart",
    "exitEvent",
    "redisExit",
    "run",
    "stat",
    "server",
    "express",
    "wss",
    "wsf",
    "prepareEvent",
    "pickFriend",
    "pickUser",
    "pickGroup",
    "pickMember",
    "fs",
]);
export class AdapterBridgeError extends Error {
    code;
    /** 创建带错误码的适配器协议错误。 */
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** 抛出适配器协议错误。 */
export function adapterFail(code, message) {
    throw new AdapterBridgeError(code, message);
}
/** 校验适配器内的 id。 */
export function adapterId(value) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
        return value;
    if (typeof value === "string" &&
        /^[\p{L}\p{N}_.:@-]{1,128}$/u.test(value) &&
        !forbidden.has(value))
        return value;
    return adapterFail("ADAPTER_INVALID_ID", "Adapter IDs must be bounded scalar identifiers");
}
/** 把 id 转为 Map 键。 */
export function adapterKey(value) {
    return String(adapterId(value));
}
/** 校验指定前缀的句柄。 */
export function adapterHandle(value, prefix) {
    if (typeof value !== "string" || !new RegExp(`^${prefix}-[0-9a-f-]{36}$`).test(value))
        return adapterFail("ADAPTER_INVALID_HANDLE", "Invalid adapter capability handle");
    return value;
}
/** 两端独立校验；访问器、函数和 SDK 原型不能跨越 IPC。 */
export function adapterDto(value) {
    const seen = new Set();
    const copy = (value, depth) => {
        if (depth > 16)
            return adapterFail("ADAPTER_INVALID_DTO", "Adapter DTO is too deep");
        if (value === null || value === undefined)
            return null;
        if (typeof value === "boolean" || typeof value === "string")
            return value;
        if (typeof value === "number" && Number.isFinite(value))
            return value;
        if (typeof value !== "object")
            return adapterFail("ADAPTER_INVALID_DTO", "Adapter DTO contains a non-value");
        if (seen.has(value))
            return adapterFail("ADAPTER_INVALID_DTO", "Cyclic adapter DTO");
        if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
            return adapterFail("ADAPTER_INVALID_DTO", "Adapter DTO contains an SDK instance");
        seen.add(value);
        try {
            if (Array.isArray(value))
                return value.map(item => copy(item, depth + 1));
            const result = Object.create(null);
            for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
                if (!descriptor.enumerable)
                    continue;
                if (forbidden.has(key) || !Object.hasOwn(descriptor, "value"))
                    return adapterFail("ADAPTER_INVALID_DTO", "Unsafe adapter DTO property");
                result[key] = copy(descriptor.value, depth + 1);
            }
            return result;
        }
        finally {
            seen.delete(value);
        }
    };
    const result = copy(value, 0);
    if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024)
        return adapterFail("ADAPTER_FRAME_LIMIT", "Adapter DTO exceeds 64 KiB; pagination is required");
    return result;
}
/** 校验为普通对象行。 */
export function adapterRow(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return adapterFail("ADAPTER_INVALID_DTO", "Expected adapter object");
    return value;
}
/** 拒绝不在允许列表中的字段。 */
function keys(row, allowed) {
    if (Object.keys(row).some(key => !allowed.includes(key)))
        adapterFail("ADAPTER_INVALID_DTO", "Unknown adapter field");
}
/** 校验有界文本。 */
function text(value) {
    if (typeof value !== "string" || value.length > 256)
        return adapterFail("ADAPTER_INVALID_DTO", "Invalid adapter metadata string");
    return value;
}
/** 校验方法句柄表。 */
function methods(value, allowed) {
    const result = adapterRow(value);
    keys(result, [...allowed]);
    for (const handle of Object.values(result))
        adapterHandle(handle, "method");
    return result;
}
/** 校验资料条目。 */
function profile(value) {
    const result = adapterRow(value);
    if (Object.keys(result).some(key => !adapterProfileKeys.includes(key)))
        adapterFail("ADAPTER_INVALID_DTO", "Unknown profile metadata");
    if (Object.values(result).some(item => item !== null && !["string", "boolean", "number"].includes(typeof item)))
        adapterFail("ADAPTER_INVALID_DTO", "Profile values must be scalar");
    return result;
}
/** 校验条目列表。 */
function entries(value) {
    if (!Array.isArray(value) || value.length > 256)
        return adapterFail("ADAPTER_COLLECTION_LIMIT", "Adapter collection exceeds its bound");
    const seen = new Set();
    return value.map(item => {
        if (!Array.isArray(item) || item.length !== 2)
            return adapterFail("ADAPTER_INVALID_DTO", "Invalid adapter map entry");
        const id = adapterId(item[0]), key = `${typeof id}:${id}`;
        if (seen.has(key))
            adapterFail("ADAPTER_INVALID_DTO", "Duplicate adapter map key");
        seen.add(key);
        return [id, profile(item[1])];
    });
}
/** 校验适配器方法调用。 */
export function validateAdapterCall(input) {
    const row = adapterRow(adapterDto(input));
    keys(row, ["methodHandle", "args", "selector"]);
    adapterHandle(row.methodHandle, "method");
    if (!Array.isArray(row.args) || row.args.length > 16)
        adapterFail("ADAPTER_INVALID_DTO", "Invalid adapter argument count");
    if (row.selector !== undefined) {
        const selector = adapterRow(row.selector);
        if (selector.kind === "friend") {
            keys(selector, ["kind", "userId"]);
            adapterId(selector.userId);
        }
        else if (selector.kind === "group") {
            keys(selector, ["kind", "groupId"]);
            adapterId(selector.groupId);
        }
        else if (selector.kind === "member") {
            keys(selector, ["kind", "groupId", "userId"]);
            adapterId(selector.groupId);
            adapterId(selector.userId);
        }
        else
            adapterFail("ADAPTER_INVALID_SELECTOR", "Unknown lazy entity selector");
    }
    return row;
}
/** 校验适配器帧。 */
export function validateAdapterFrame(input) {
    const row = adapterRow(adapterDto(input));
    if (row.type === "register") {
        keys(row, ["type", "adapter"]);
        const value = adapterRow(row.adapter);
        keys(value, ["handle", "id", "name", "version", "loadHandle"]);
        adapterHandle(value.handle, "adapter");
        adapterHandle(value.loadHandle, "method");
        for (const key of ["id", "name", "version"])
            text(value[key]);
    }
    else if (row.type === "account") {
        keys(row, ["type", "account"]);
        const value = adapterRow(row.account);
        keys(value, [
            "handle",
            "id",
            "adapterHandle",
            "metadata",
            "friends",
            "groups",
            "members",
            "methods",
            "entityMethods",
        ]);
        adapterHandle(value.handle, "account");
        adapterHandle(value.adapterHandle, "adapter");
        adapterId(value.id);
        const metadata = adapterRow(value.metadata);
        if (Object.keys(metadata).some(key => !metadataKeys.has(key)))
            adapterFail("ADAPTER_INVALID_DTO", "Unknown account metadata");
        for (const [key, item] of Object.entries(metadata)) {
            if (key === "info")
                profile(item);
            else if (key === "version") {
                const value = adapterRow(item);
                keys(value, ["id", "name", "version"]);
                for (const item of Object.values(value))
                    text(item);
            }
            else if (key === "stat") {
                const value = adapterRow(item);
                keys(value, ["start_time", "online"]);
                if (Object.values(value).some(item => typeof item !== "number" || !Number.isFinite(item)))
                    adapterFail("ADAPTER_INVALID_DTO", "Invalid account statistics");
            }
            else
                profile({ [key]: item });
        }
        entries(value.friends);
        entries(value.groups);
        if (!Array.isArray(value.members) || value.members.length > 256)
            adapterFail("ADAPTER_COLLECTION_LIMIT", "Too many group member maps");
        for (const item of value.members) {
            if (!Array.isArray(item) || item.length !== 2)
                adapterFail("ADAPTER_INVALID_DTO", "Invalid group member entry");
            adapterId(item[0]);
            entries(item[1]);
        }
        methods(value.methods, adapterAccountMethods);
        methods(value.entityMethods, adapterEntityMethods);
    }
    else if (row.type === "event") {
        keys(row, ["type", "accountHandle", "name", "event"]);
        adapterHandle(row.accountHandle, "account");
        text(row.name);
        adapterRow(row.event);
    }
    else if (row.type === "remove") {
        keys(row, ["type", "accountHandle"]);
        adapterHandle(row.accountHandle, "account");
    }
    else
        adapterFail("ADAPTER_INVALID_DTO", "Unknown adapter frame");
    return row;
}
/** 判断事件名是否属于该 id 的合法事件。 */
export function validAdapterEvent(name, id) {
    return (name === `connect.${id}` ||
        name === `disconnect.${id}` ||
        /^(message|notice|request)(?:\.[A-Za-z0-9_-]+){0,2}$/.test(name) ||
        ["system.online", "system.offline", "internal.input", "sync"].includes(name));
}
export const adapterEventKeys = new Set([
    "self_id",
    "post_type",
    "message_type",
    "notice_type",
    "request_type",
    "sub_type",
    "user_id",
    "group_id",
    "message_id",
    "time",
    "raw_message",
    "message",
    "sender",
    "group_name",
    "operator_id",
    "target_id",
    "duration",
    "comment",
    "flag",
    "value",
]);
/** 校验适配器事件，非法时抛错。 */
export function validateAdapterEvent(event, name, id) {
    if (adapterKey(event.self_id) !== adapterKey(id) || !validAdapterEvent(name, id))
        adapterFail("ADAPTER_EVENT_DENIED", "Event is outside this account's namespace");
    if (Object.keys(event).some(key => !adapterEventKeys.has(key)))
        adapterFail("ADAPTER_EVENT_DENIED", "Event contains capabilities or host permission flags");
    if (event.sender !== undefined)
        profile(event.sender);
    for (const key of ["user_id", "group_id", "operator_id", "target_id"])
        if (event[key] !== undefined)
            adapterId(event[key]);
    if (event.message_id !== undefined &&
        !(typeof event.message_id === "string" && event.message_id.length <= 1024) &&
        !(typeof event.message_id === "number" && Number.isSafeInteger(event.message_id)))
        adapterFail("ADAPTER_EVENT_DENIED", "Invalid message identifier");
    for (const key of ["post_type", "message_type", "notice_type", "request_type", "sub_type"]) {
        const value = event[key];
        if (value !== undefined && (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)))
            adapterFail("ADAPTER_EVENT_DENIED", "Invalid event subtype");
    }
    for (const key of ["raw_message", "group_name", "comment", "flag"]) {
        const value = event[key];
        if (value !== undefined &&
            (typeof value !== "string" || value.length > (key === "raw_message" ? 32000 : 2048)))
            adapterFail("ADAPTER_EVENT_DENIED", "Invalid event text");
    }
    for (const key of ["time", "duration"])
        if (event[key] !== undefined &&
            (typeof event[key] !== "number" || !Number.isFinite(event[key])))
            adapterFail("ADAPTER_EVENT_DENIED", "Invalid event numeric field");
    const [kind, type, subtype] = name.split(".");
    if (["message", "notice", "request"].includes(kind)) {
        if (event.post_type !== kind ||
            (type !== undefined && event[`${kind}_type`] !== type) ||
            (subtype !== undefined && event.sub_type !== subtype))
            adapterFail("ADAPTER_EVENT_DENIED", "Event payload does not match its routing name");
        if (kind === "message" && typeof event.message_type !== "string")
            adapterFail("ADAPTER_EVENT_DENIED", "Message type is required");
    }
    if (kind === "message" || event.message !== undefined) {
        if (!Array.isArray(event.message) || event.message.length > 128)
            adapterFail("ADAPTER_EVENT_DENIED", "Message must be a bounded segment array");
        for (const segment of event.message) {
            const row = adapterRow(segment);
            if (typeof row.type !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(row.type))
                adapterFail("ADAPTER_EVENT_DENIED", "Message segment type is invalid");
            if (row.type === "text" && typeof row.text !== "string")
                adapterFail("ADAPTER_EVENT_DENIED", "Text segment must contain text");
        }
    }
}
//# sourceMappingURL=protocol.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../../protect/objects.js"
__guardRegisterExports("native-sandbox/adapter/protocol.ts", { adapterAccountMethods, adapterEntityMethods, adapterProfileKeys, reservedAdapterIds, AdapterBridgeError, adapterFail, adapterId, adapterKey, adapterHandle, adapterDto, adapterRow, validateAdapterCall, validateAdapterFrame, validAdapterEvent, adapterEventKeys, validateAdapterEvent })
