import { M } from "../shared/messages.js";
/** 在业务插件加载前捕获入口，仅供 Guard 内部调用，不冻结业务内建对象。 */
const call = Reflect.apply;
const ObjectClass = Object;
const MapClass = Map;
const SetClass = Set;
const WeakMapClass = WeakMap;
const WeakSetClass = WeakSet;
const PromiseClass = Promise;
const ErrorClass = Error;
const StringClass = String;
const DateClass = Date;
const captures = {
    array: Array.isArray,
    create: Object.create,
    define: Object.defineProperty,
    hasOwn: Object.prototype.hasOwnProperty,
    descriptor: Object.getOwnPropertyDescriptor,
    freeze: Object.freeze,
    entries: Object.entries,
    values: Object.values,
    keys: Object.keys,
    prototype: Object.getPrototypeOf,
    extensible: Object.isExtensible,
    symbols: Object.getOwnPropertySymbols,
    ownKeys: Reflect.ownKeys,
    get: Reflect.get,
    parse: JSON.parse,
    stringify: JSON.stringify,
    startsWith: String.prototype.startsWith,
    endsWith: String.prototype.endsWith,
    slice: String.prototype.slice,
    lower: String.prototype.toLowerCase,
    indexOf: String.prototype.indexOf,
    mapGet: Map.prototype.get,
    mapSet: Map.prototype.set,
    mapHas: Map.prototype.has,
    mapDelete: Map.prototype.delete,
    mapClear: Map.prototype.clear,
    mapEach: Map.prototype.forEach,
    mapSize: Object.getOwnPropertyDescriptor(Map.prototype, "size").get,
    setAdd: Set.prototype.add,
    setHas: Set.prototype.has,
    setDelete: Set.prototype.delete,
    setEach: Set.prototype.forEach,
    weakMapGet: WeakMap.prototype.get,
    weakMapSet: WeakMap.prototype.set,
    weakMapHas: WeakMap.prototype.has,
    weakMapDelete: WeakMap.prototype.delete,
    weakSetAdd: WeakSet.prototype.add,
    weakSetHas: WeakSet.prototype.has,
    resolve: Promise.resolve,
    reject: Promise.reject,
    then: Promise.prototype.then,
    integer: Number.isInteger,
    safeInteger: Number.isSafeInteger,
    finite: Number.isFinite,
    exec: RegExp.prototype.exec,
    byteLength: Buffer.byteLength,
    min: Math.min,
    max: Math.max,
    iso: Date.prototype.toISOString,
};
let reflection = { defineProperty: captures.define, freeze: captures.freeze };
let reflectionClaimed = false;
/** 反射观察器在模块初始化时领取一次配置能力；能力本身只留在其闭包中。 */
export function claimReflectionHooks() {
    if (reflectionClaimed) {
        const failure = new ErrorClass(M.protect.reflectionClaimed);
        captures.define(failure, "code", { value: "ERR_GUARD_SELF_PROTECTION" });
        throw failure;
    }
    reflectionClaimed = true;
    return hooks => {
        const previous = reflection;
        reflection = hooks;
        return () => {
            if (reflection === hooks)
                reflection = previous;
        };
    };
}
/** 使用预先捕获的 Reflect.apply 调用函数。 */
export const apply = (fn, receiver, args) => call(fn, receiver, args);
/** 内部描述符只采用自有字段，隔绝 Object.prototype 上的同名属性。 */
export function cleanDescriptor(descriptor) {
    const clean = captures.create(null);
    const fields = ["value", "get", "set", "writable", "enumerable", "configurable"];
    for (let index = 0; index < fields.length; index++) {
        const field = fields[index];
        if (call(captures.hasOwn, descriptor, [field]))
            clean[field] = captures.get(descriptor, field);
    }
    return clean;
}
/** 使用清洗后的描述符定义属性；经过已安装的反射监控，不导出原始写入口。 */
export const objectDefine = (object, key, descriptor) => call(reflection.defineProperty, ObjectClass, [object, key, cleanDescriptor(descriptor)]);
/** 使用捕获的 Object.create 创建对象。 */
export const objectCreate = (...args) => call(captures.create, undefined, args);
/** 判断对象是否有自有属性。 */
export const objectHasOwn = (object, key) => call(captures.hasOwn, object, [key]);
/** 判断值是否为对象或函数（可持有属性的引用）。 */
export const isReference = (value) => (typeof value === "object" && value !== null) || typeof value === "function";
const descriptorFields = ["value", "get", "set", "writable", "enumerable", "configurable"];
/** 逐字段比较两个描述符；两者都缺失时视为相同。 */
export function sameDescriptor(a, b) {
    if (!a || !b)
        return a === b;
    for (let index = 0; index < descriptorFields.length; index++) {
        const field = descriptorFields[index];
        if (a[field] !== b[field])
            return false;
    }
    return true;
}
/** 读取清洗后的自有属性描述符。 */
export function objectDescriptor(object, key) {
    const descriptor = captures.descriptor(object, key);
    return descriptor && cleanDescriptor(descriptor);
}
/** 读取全部清洗后的自有属性描述符。 */
export function objectDescriptors(object) {
    const result = captures.create(null);
    const keys = captures.ownKeys(object);
    for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        const descriptor = objectDescriptor(object, key);
        if (descriptor)
            result[key] = descriptor;
    }
    return result;
}
/** 冻结对象，同样经过反射监控。 */
export const objectFreeze = (object) => call(reflection.freeze, ObjectClass, [object]);
/** 列出自有可枚举键值对。 */
export const objectEntries = (object) => captures.entries(object);
/** 列出自有可枚举值。 */
export const objectValues = (object) => captures.values(object);
/** 列出自有可枚举键。 */
export const objectKeys = (object) => captures.keys(object);
/** 读取原型。 */
export const objectPrototype = (object) => captures.prototype(object);
/** 判断对象是否可扩展。 */
export const objectExtensible = (object) => captures.extensible(object);
/** 列出自有 Symbol 键。 */
export const objectSymbols = (object) => captures.symbols(object);
/** 列出全部自有键。 */
export const ownKeys = (object) => captures.ownKeys(object);
/** 读取属性值。 */
export const reflectGet = (object, key) => captures.get(object, key);
/** 返回原始 Object.prototype。 */
export const objectBase = () => ObjectClass.prototype;
/** 解析 JSON。 */
export const jsonParse = (text, reviver) => captures.parse(text, reviver);
/** 序列化为 JSON。 */
export const jsonStringify = (...args) => call(captures.stringify, undefined, args);
/** 转换为字符串。 */
export const string = (value) => StringClass(value);
/** 创建原始 Error。 */
export const error = (message) => new ErrorClass(message);
/** 判断是否为整数。 */
export const numberIsInteger = (value) => captures.integer(value);
/** 判断是否为安全整数。 */
export const numberIsSafeInteger = (value) => captures.safeInteger(value);
/** 判断是否为有限数。 */
export const numberIsFinite = (value) => captures.finite(value);
/** 判断正则是否匹配。 */
export const regexpTest = (expression, value) => call(captures.exec, expression, [value]) !== null;
/** 计算字符串字节长度。 */
export const bufferByteLength = (...args) => call(captures.byteLength, undefined, args);
/** 取最小值。 */
export const mathMin = (...values) => call(captures.min, undefined, values);
/** 取最大值。 */
export const mathMax = (...values) => call(captures.max, undefined, values);
/** 返回当前时间的 ISO 字符串。 */
export const timestamp = () => call(captures.iso, new DateClass(), []);
/** 判断字符串前缀。 */
export const stringStartsWith = (value, prefix) => call(captures.startsWith, value, [prefix]);
/** 判断字符串后缀。 */
export const stringEndsWith = (value, suffix) => call(captures.endsWith, value, [suffix]);
/** 截取字符串。 */
export const stringSlice = (value, start, end) => call(captures.slice, value, [start, end]);
/** 按分隔符拆分字符串，不经过可替换的 split。 */
export function stringSplit(value, separator) {
    const result = [];
    if (!separator) {
        for (let index = 0; index < value.length; index++)
            arrayPush(result, value[index]);
        return result;
    }
    let cursor = 0;
    let next;
    while ((next = call(captures.indexOf, value, [separator, cursor])) >= 0) {
        arrayPush(result, stringSlice(value, cursor, next));
        cursor = next + separator.length;
    }
    arrayPush(result, stringSlice(value, cursor));
    return result;
}
/** 转为小写。 */
export const stringLower = (value) => call(captures.lower, value, []);
/** 查找子串位置。 */
export const stringIndexOf = (value, search) => call(captures.indexOf, value, [search]);
// 内部数组均为密集数组，索引遍历不读取可被业务替换的迭代器或 species。
/** 判断是否为数组。 */
export const arrayIsArray = (value) => captures.array(value);
/** 按索引遍历数组。 */
export function arrayEach(values, visit) {
    for (let index = 0; index < values.length; index++)
        visit(values[index], index);
}
/** 按索引映射数组。 */
export function arrayMap(values, visit) {
    const result = [];
    arrayEach(values, (value, index) => {
        arrayPush(result, visit(value, index));
    });
    return result;
}
/** 判断是否存在满足条件的元素。 */
export function arraySome(values, visit) {
    for (let index = 0; index < values.length; index++)
        if (visit(values[index], index))
            return true;
    return false;
}
/** 判断数组是否包含元素，NaN 视为相等。 */
export const arrayIncludes = (values, item) => arraySome(values, value => value === item || (value !== value && item !== item));
/** 判断是否全部元素满足条件。 */
export const arrayEvery = (values, visit) => !arraySome(values, (value, index) => !visit(value, index));
/** 按条件过滤数组。 */
export function arrayFilter(values, visit) {
    const result = [];
    arrayEach(values, (value, index) => {
        if (visit(value, index))
            arrayPush(result, value);
    });
    return result;
}
/** 移除并返回首个元素。 */
export function arrayShift(values) {
    if (!values.length)
        return undefined;
    const first = values[0];
    for (let index = 1; index < values.length; index++)
        values[index - 1] = values[index];
    values.length--;
    return first;
}
/** 以定义属性的方式追加元素，不触发可替换的 setter。 */
export const arrayPush = (values, value) => {
    objectDefine(values, StringClass(values.length), {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
    });
};
/** 复制数组片段。 */
export function arraySlice(values, start = 0, end = values.length) {
    const result = [];
    for (let index = start; index < end; index++)
        arrayPush(result, values[index]);
    return result;
}
/** 创建 Map。 */
export const newMap = () => new MapClass();
/** 读取 Map 项。 */
export const mapGet = (map, key) => call(captures.mapGet, map, [key]);
/** 写入 Map 项。 */
export const mapSet = (map, key, value) => {
    call(captures.mapSet, map, [key, value]);
};
/** 判断 Map 是否有键。 */
export const mapHas = (map, key) => call(captures.mapHas, map, [key]);
/** 删除 Map 项。 */
export const mapDelete = (map, key) => call(captures.mapDelete, map, [key]);
/** 清空 Map。 */
export const mapClear = (map) => {
    call(captures.mapClear, map, []);
};
/** 遍历 Map。 */
export const mapEach = (map, visit) => {
    call(captures.mapEach, map, [visit]);
};
/** 读取 Map 大小。 */
export const mapSize = (map) => call(captures.mapSize, map, []);
/** 创建 Set。 */
export const newSet = () => new SetClass();
/** 向 Set 添加值。 */
export const setAdd = (set, value) => {
    call(captures.setAdd, set, [value]);
};
/** 判断 Set 是否有值。 */
export const setHas = (set, value) => call(captures.setHas, set, [value]);
/** 从 Set 删除值。 */
export const setDelete = (set, value) => call(captures.setDelete, set, [value]);
/** 遍历 Set。 */
export const setEach = (set, visit) => {
    call(captures.setEach, set, [visit]);
};
/** 创建 WeakMap。 */
export const newWeakMap = () => new WeakMapClass();
/** 读取 WeakMap 项。 */
export const weakMapGet = (map, key) => call(captures.weakMapGet, map, [key]);
/** 写入 WeakMap 项。 */
export const weakMapSet = (map, key, value) => {
    call(captures.weakMapSet, map, [key, value]);
};
/** 判断 WeakMap 是否有键。 */
export const weakMapHas = (map, key) => call(captures.weakMapHas, map, [key]);
/** 删除 WeakMap 项。 */
export const weakMapDelete = (map, key) => call(captures.weakMapDelete, map, [key]);
/** 创建 WeakSet。 */
export const newWeakSet = () => new WeakSetClass();
/** 向 WeakSet 添加值。 */
export const weakSetAdd = (set, value) => {
    call(captures.weakSetAdd, set, [value]);
};
/** 判断 WeakSet 是否有值。 */
export const weakSetHas = (set, value) => call(captures.weakSetHas, set, [value]);
/** 创建已解决的 Promise。 */
export const promiseResolve = (value) => call(captures.resolve, PromiseClass, [value]);
/** 创建已拒绝的 Promise。 */
export const promiseReject = (reason) => call(captures.reject, PromiseClass, [reason]);
/** 注册 Promise 回调。 */
export const promiseThen = (promise, visit, rejected) => call(captures.then, promise, [visit, rejected]);
//# sourceMappingURL=intrinsics.js.map