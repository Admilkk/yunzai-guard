import { sandboxFilename } from "./filesystem.js";
/** 引擎输出不可信；插件身份和授权仅由调用方提供。 */
export function validateSandboxActions(value, plugin) {
    if (!value || typeof value !== "object")
        throw new Error("invalid-result");
    const result = value;
    if (result.ok !== true || !Array.isArray(result.actions) || result.actions.length > 16)
        throw new Error("execution-denied");
    let bytes = 0;
    return result.actions.map(item => {
        if (!item || typeof item !== "object" || Array.isArray(item))
            throw new Error("invalid-action");
        const action = item;
        if (!plugin.capabilities.includes(action.capability) ||
            typeof action.text !== "string" ||
            Object.keys(item).some(key => !["capability", "text", "file"].includes(key)) ||
            action.text.length > (action.capability === "writeText" ? 16384 : 4096))
            throw new Error("capability-denied");
        if (action.capability === "writeText")
            sandboxFilename(action.file);
        else if (action.file !== undefined)
            throw new Error("invalid-action");
        bytes += Buffer.byteLength(action.text) + Buffer.byteLength(action.file ?? "");
        if (bytes > 32768)
            throw new Error("output-budget");
        return {
            capability: action.capability,
            text: action.text,
            ...(action.file === undefined ? {} : { file: action.file }),
        };
    });
}
/** 把消息事件转为传入受限脚本的有界快照。 */
export function sandboxEvent(event) {
    const text = (value, limit) => typeof value === "string"
        ? value.slice(0, limit)
        : typeof value === "number" && Number.isFinite(value)
            ? String(value)
            : "";
    return {
        message: text(event.msg, 8192),
        userId: text(event.user_id, 128),
        groupId: text(event.group_id, 128),
        selfId: text(event.self_id, 128),
        isGroup: event.isGroup === true,
    };
}
//# sourceMappingURL=actions.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("plugin-sandbox/actions.ts", { validateSandboxActions, sandboxEvent })
