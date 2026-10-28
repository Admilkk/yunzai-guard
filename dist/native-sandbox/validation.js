import { parseNativePriority } from "./priority.js";
import { M } from "../shared/messages.js";
/** 校验为普通对象。 */
function row(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(M.nativeSandbox.metadataExpected);
    return value;
}
/** 拒绝未知字段。 */
function keys(value, allowed) {
    if (Object.keys(value).some(key => !allowed.includes(key)))
        throw new Error(M.nativeSandbox.metadataField);
}
/** 校验有界文本。 */
function text(value, limit = 2048) {
    if (typeof value !== "string" || value.length > limit)
        throw new Error(M.nativeSandbox.boundedText);
}
/** 校验数字。 */
function numeric(value) {
    parseNativePriority(value);
}
/** 校验回调描述。 */
function callback(value) {
    const item = row(value);
    keys(item, ["$type", "id"]);
    if (item.$type !== "NativeFunction")
        throw new Error(M.nativeSandbox.callbackExpected);
    text(item.id, 128);
}
/** 仅校验核心会解释的数据，插件代码、正则和回调不进入宿主。 */
export function validateNativeDescriptor(value) {
    const item = row(value);
    keys(item, ["id", "name", "metadata", "methods"]);
    text(item.id, 512);
    text(item.name, 256);
    if (!Array.isArray(item.methods) ||
        item.methods.length > 257 ||
        new Set(item.methods).size !== item.methods.length)
        throw new Error(M.nativeSandbox.methods);
    if (item.methods.length === 257 &&
        (typeof item.methods[256] !== "string" ||
            !/^guardMissingRule_[0-9a-f]{32}$/.test(item.methods[256])))
        throw new Error(M.nativeSandbox.methodSlot);
    for (const method of item.methods) {
        text(method, 128);
        if (["constructor", "prototype", "__proto__", "then"].includes(method))
            throw new Error(M.nativeSandbox.unsafeMethod);
    }
    const methods = new Set(item.methods);
    const metadata = row(item.metadata);
    keys(metadata, ["name", "dsc", "event", "priority", "rule", "task", "handler", "namespace"]);
    for (const key of ["name", "dsc", "event", "namespace"])
        if (metadata[key] !== undefined)
            text(metadata[key], key === "name" ? 256 : 2048);
    numeric(metadata.priority);
    if (!Array.isArray(metadata.rule) || metadata.rule.length > 256)
        throw new Error(M.nativeSandbox.rules);
    for (const value of metadata.rule) {
        const rule = row(value);
        keys(rule, ["reg", "fnc", "event", "log", "permission"]);
        if (!methods.has(rule.fnc))
            throw new Error(M.nativeSandbox.ruleUnregistered(typeof rule.fnc === "string" ? rule.fnc.slice(0, 128) : "<non-string>"));
        if (typeof rule.reg === "string")
            text(rule.reg, 8192);
        else {
            const regexp = row(rule.reg);
            keys(regexp, ["$type", "source", "flags"]);
            if (regexp.$type !== "RegExp")
                throw new Error(M.nativeSandbox.regexp);
            text(regexp.source, 8192);
            text(regexp.flags, 16);
        }
        if (rule.event !== undefined)
            text(rule.event);
        if (rule.log !== undefined && typeof rule.log !== "boolean")
            throw new Error(M.nativeSandbox.ruleLog);
        if (rule.permission !== undefined &&
            !["", "master", "owner", "admin", "all"].includes(String(rule.permission)))
            throw new Error(M.nativeSandbox.permission);
    }
    if (metadata.task !== undefined) {
        const tasks = Array.isArray(metadata.task) ? metadata.task : [metadata.task];
        if (tasks.length > 64)
            throw new Error(M.nativeSandbox.taskLimit);
        for (const value of tasks) {
            const task = row(value);
            keys(task, ["name", "cron", "fnc", "log"]);
            if (task.name !== undefined)
                text(task.name, 256);
            text(task.cron, 128);
            if (task.log !== undefined && typeof task.log !== "boolean")
                throw new Error(M.nativeSandbox.taskLog);
            if (typeof task.fnc === "string") {
                if (task.fnc && !methods.has(task.fnc))
                    throw new Error(M.nativeSandbox.taskMethod);
            }
            else
                callback(task.fnc);
        }
    }
    if (metadata.handler !== undefined) {
        const handlers = Array.isArray(metadata.handler)
            ? metadata.handler
            : Object.values(row(metadata.handler));
        if (handlers.length > 64)
            throw new Error(M.nativeSandbox.handlerLimit);
        for (const value of handlers) {
            const handler = row(value);
            keys(handler, ["fn", "key", "priority"]);
            text(handler.key, 256);
            if (handler.priority !== undefined)
                numeric(handler.priority);
            if (typeof handler.fn === "string") {
                if (!methods.has(handler.fn))
                    throw new Error(M.nativeSandbox.handlerMethod);
            }
            else
                callback(handler.fn);
        }
    }
    return item;
}
/** 适配器可为媒体消息读取文件或 URL，但不能将这些来源转成宿主权限。 */
export function validateReplyArguments(args) {
    if (!args.length || args.length > 3)
        throw new Error(M.nativeSandbox.replyArgs);
    let size = 0;
    /** 校验消息结构。 */
    function message(value) {
        if (typeof value === "string") {
            size += value.length;
            return;
        }
        if (Array.isArray(value)) {
            if (value.length > 64)
                throw new Error(M.nativeSandbox.replySegments);
            for (const segment of value) {
                if (Array.isArray(segment))
                    throw new Error(M.nativeSandbox.replyNested);
                message(segment);
            }
            return;
        }
        const segment = row(value);
        keys(segment, ["type", "text"]);
        if (segment.type !== "text")
            throw new Error(M.nativeSandbox.replyTextOnly);
        text(segment.text, 32000);
        size += segment.text.length;
    }
    message(args[0]);
    if (size > 32000)
        throw new Error(M.nativeSandbox.replyTooLong);
    if (args[1] !== undefined && args[1] !== null && typeof args[1] !== "boolean")
        throw new Error(M.nativeSandbox.replyQuote);
    if (args[2] !== undefined && args[2] !== null && Object.keys(row(args[2])).length)
        throw new Error(M.nativeSandbox.replyOptions);
    return [args[0], args[1] === true, {}];
}
//# sourceMappingURL=validation.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("native-sandbox/validation.ts", { validateNativeDescriptor, validateReplyArguments })
