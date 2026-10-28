import { M } from "../shared/messages.js";
const actions = ["audit", "deny", "restart"];
/** 校验值为普通对象，否则抛出带位置的配置错误。 */
export function object(value, location) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new TypeError(M.config.object(location));
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw new TypeError(M.config.plainObject(location));
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor))
            throw new TypeError(M.config.plainProperties(location));
    }
    return value;
}
/** 拒绝不在允许列表中的配置键。 */
export function keys(value, allowed, location) {
    for (const key of Object.keys(value))
        if (!allowed.includes(key))
            throw new TypeError(M.config.unknownSetting(location, key));
}
/** 读取整数配置，缺省时使用默认值并检查上下限。 */
export function number(value, fallback, location, min, max) {
    const result = value === undefined ? fallback : value;
    if (typeof result !== "number" || !Number.isSafeInteger(result) || result < min || result > max)
        throw new TypeError(M.config.integer(location, min, max));
    return result;
}
/** 读取布尔配置，缺省时使用默认值。 */
export function boolean(value, fallback, location) {
    if (value === undefined)
        return fallback;
    if (typeof value !== "boolean")
        throw new TypeError(M.config.boolean(location));
    return value;
}
/** 读取非空字符串配置并限制长度。 */
export function string(value, location, maxLength = 512) {
    if (typeof value !== "string" ||
        !value.length ||
        value.length > maxLength ||
        /[\0\r\n]/.test(value))
        throw new TypeError(M.config.string(location, maxLength));
    return value;
}
/** 读取规则动作（audit/deny/restart）。 */
export function action(value, fallback, location) {
    const result = value === undefined ? fallback : value;
    if (!actions.includes(result))
        throw new TypeError(M.config.action(location));
    return result;
}
/** 解析并校验一条规则。 */
export function rule(value, index) {
    const location = typeof index === "number" ? `settings.rules[${index}]` : index;
    const source = object(value, location);
    keys(source, ["id", "kind", "plugin", "operation", "target", "action"], location);
    if (source.action === undefined)
        throw new TypeError(M.config.actionRequired(location));
    const result = {
        id: string(source.id, `${location}.id`, 100),
        action: action(source.action, "audit", `${location}.action`),
    };
    for (const key of ["plugin", "operation", "target"])
        if (source[key] !== undefined)
            result[key] = string(source[key], `${location}.${key}`);
    if (source.kind !== undefined) {
        if (Array.isArray(source.kind)) {
            if (!source.kind.length || source.kind.length > 32)
                throw new TypeError(M.config.kindPatterns(location));
            result.kind = source.kind.map((item, i) => string(item, `${location}.kind[${i}]`, 100));
        }
        else
            result.kind = string(source.kind, `${location}.kind`, 100);
    }
    return result;
}
//# sourceMappingURL=validation.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("config/validation.ts", { object, keys, number, boolean, string, action, rule })
