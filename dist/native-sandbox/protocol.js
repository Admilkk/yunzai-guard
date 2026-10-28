import { M } from "../shared/messages.js";
export const maxFrameBytes = 64 * 1024;
export class ProtocolError extends Error {
    code;
    /** 创建带错误码的协议错误。 */
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** 活动对象、函数、getter 和携带自定义原型的实例不能跨越 IPC。 */
export function toDto(value, metadata = false, seen = new Set(), depth = 0) {
    const unsupported = (message) => {
        throw new ProtocolError(metadata ? "UNSUPPORTED_METADATA" : "UNSUPPORTED_DTO", message);
    };
    if (depth > 20)
        return unsupported("DTO exceeds maximum depth");
    if (value === undefined || value === null)
        return null;
    if (typeof value === "string" || typeof value === "boolean")
        return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            return unsupported("Non-finite numbers cannot cross IPC");
        return value;
    }
    if (typeof value !== "object")
        return unsupported(`Cannot transfer ${typeof value}`);
    if (value instanceof RegExp)
        return { $type: "RegExp", source: value.source, flags: value.flags };
    if (value instanceof Error)
        return { $type: "Error", name: value.name, message: value.message, stack: value.stack ?? "" };
    if (seen.has(value))
        return unsupported("Cyclic objects cannot cross IPC");
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        return unsupported("Only JSON objects and RegExp tags can cross IPC");
    seen.add(value);
    try {
        if (Array.isArray(value))
            return value.map(item => toDto(item, metadata, seen, depth + 1));
        const result = Object.create(null);
        for (const key of Object.keys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!Object.hasOwn(descriptor, "value"))
                return unsupported("Accessors cannot cross IPC");
            if (key === "__proto__" || key === "constructor" || key === "prototype")
                return unsupported("Unsafe DTO property");
            result[key] = toDto(descriptor.value, metadata, seen, depth + 1);
        }
        return result;
    }
    finally {
        seen.delete(value);
    }
}
/** 把 DTO 还原为值。 */
export function fromDto(value, depth = 0) {
    const dto = toDto(value);
    const decode = (item, level) => {
        if (level > 20)
            throw new ProtocolError("INVALID_DTO", M.nativeSandbox.dtoDepth);
        if (item === null || typeof item !== "object")
            return item;
        if (Array.isArray(item))
            return item.map(child => decode(child, level + 1));
        if (item.$type === "RegExp") {
            if (typeof item.source !== "string" || typeof item.flags !== "string")
                throw new ProtocolError("INVALID_DTO", M.nativeSandbox.regexpTag);
            return new RegExp(item.source, item.flags);
        }
        return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, decode(child, level + 1)]));
    };
    return decode(dto, depth);
}
//# sourceMappingURL=protocol.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("native-sandbox/protocol.ts", { maxFrameBytes, ProtocolError, toDto, fromDto })
