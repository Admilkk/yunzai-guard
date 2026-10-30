import { types } from "node:util";
import { apply, cleanDescriptor, claimReflectionHooks, objectDescriptor as descriptor, objectPrototype as prototype, objectExtensible as extensible, ownKeys, newMap, mapSet, mapGet, mapEach, mapSize, newWeakMap, weakMapGet, weakMapSet, newSet, setAdd, setDelete, setEach, arrayEach, arrayMap, arrayPush, string, stringStartsWith, stringEndsWith, sameDescriptor as same, isReference, } from "../protect/intrinsics.js";
// 安装/卸载反射包装器时不能递归进入自身；此原始入口不对外暴露。
const nativeDefine = Object.defineProperty;
const define = (object, key, descriptor) => nativeDefine(object, key, cleanDescriptor(descriptor));
const bindReflection = claimReflectionHooks();
const isProxy = types.isProxy;
const slots = [
    [Object, "defineProperty"],
    [Object, "defineProperties"],
    [Object, "setPrototypeOf"],
    [Object, "assign"],
    [Object, "freeze"],
    [Object, "seal"],
    [Object, "preventExtensions"],
    [Reflect, "defineProperty"],
    [Reflect, "set"],
    [Reflect, "deleteProperty"],
    [Reflect, "setPrototypeOf"],
    [Reflect, "preventExtensions"],
    [Object.prototype, "__defineGetter__"],
    [Object.prototype, "__defineSetter__"],
];
/** 取对象属性描述符快照，不触发 Proxy trap、getter 或属性键的类型转换。 */
function snapshot(object, key) {
    if (isProxy(object))
        return undefined;
    try {
        const keys = key === undefined ? ownKeys(object) : [key];
        if (keys.length > 256)
            return undefined;
        const properties = newMap();
        arrayEach(keys, item => mapSet(properties, item, descriptor(object, item)));
        return {
            prototype: prototype(object),
            extensible: extensible(object),
            properties,
        };
    }
    catch {
        return undefined;
    }
}
/** 比较快照是否变化，无法比较时返回 undefined。 */
function changed(before, after) {
    if (!before || !after)
        return undefined;
    if (before.prototype !== after.prototype ||
        before.extensible !== after.extensible ||
        mapSize(before.properties) !== mapSize(after.properties))
        return true;
    let different = false;
    mapEach(before.properties, (value, key) => {
        if (!same(value, mapGet(after.properties, key)))
            different = true;
    });
    return different;
}
/** 只拦截显式反射调用，保留业务属性描述符和普通赋值语义。 */
export function installHookWatch() {
    const registrations = newWeakMap();
    const patches = [];
    let closed = false;
    let notifying = false;
    /** 调用原反射入口，并在目标被登记时通知监听者。 */
    function invoke(operation, original, receiver, args) {
        const legacy = stringStartsWith(operation, "Object.prototype.");
        const object = legacy ? receiver : args[0];
        if (closed || !isReference(object))
            return apply(original, receiver, args);
        const prototypeCall = stringEndsWith(operation, "setPrototypeOf");
        const keyed = legacy ||
            stringEndsWith(operation, ".defineProperty") ||
            operation === "Reflect.set" ||
            operation === "Reflect.deleteProperty";
        const rawKey = keyed && !prototypeCall ? args[legacy ? 0 : 1] : undefined;
        const key = typeof rawKey === "symbol" || typeof rawKey === "string"
            ? rawKey
            : typeof rawKey === "number"
                ? string(rawKey)
                : undefined;
        const objects = [object];
        // Reflect.set 可以把属性写到另一个 receiver。
        if (operation === "Reflect.set" && isReference(args[3]) && args[3] !== object)
            arrayPush(objects, args[3]);
        const calls = [];
        arrayEach(objects, target => {
            const entries = weakMapGet(registrations, target);
            if (!entries)
                return;
            setEach(entries, item => {
                if (item.key !== undefined && key !== undefined && item.key !== key)
                    return;
                arrayPush(calls, {
                    item,
                    request: {
                        operation,
                        object: target,
                        ...(key === undefined ? {} : { key }),
                        ...(operation === "Reflect.set" && isReference(args[3]) ? { receiver: args[3] } : {}),
                    },
                    before: notifying ? undefined : snapshot(target, key ?? item.key),
                });
            });
        });
        if (!calls.length)
            return apply(original, receiver, args);
        /** 通知监听者本次修改的结果。 */
        function notify(outcome) {
            if (notifying)
                return;
            notifying = true;
            try {
                arrayEach(calls, call => {
                    const after = snapshot(call.request.object, key ?? call.item.key);
                    const observedKey = key ?? call.item.key;
                    const before = call.before;
                    let properties;
                    if (before && after) {
                        const keys = newSet();
                        mapEach(before.properties, (_value, key) => setAdd(keys, key));
                        mapEach(after.properties, (_value, key) => setAdd(keys, key));
                        const changes = [];
                        setEach(keys, key => {
                            const previous = mapGet(before.properties, key);
                            const current = mapGet(after.properties, key);
                            if (!same(previous, current))
                                arrayPush(changes, { key, before: previous, after: current });
                        });
                        properties = changes;
                    }
                    try {
                        call.item.listener.after?.({
                            ...call.request,
                            outcome,
                            changed: changed(call.before, after),
                            properties,
                            prototypeChanged: before && after ? before.prototype !== after.prototype : undefined,
                            ...(observedKey === undefined
                                ? {}
                                : {
                                    before: call.before ? mapGet(call.before.properties, observedKey) : undefined,
                                    after: after ? mapGet(after.properties, observedKey) : undefined,
                                }),
                        });
                    }
                    catch {
                        // 观察失败不能改变业务调用的返回值或异常。
                    }
                });
            }
            finally {
                notifying = false;
            }
        }
        try {
            arrayEach(calls, call => call.item.listener.before?.(call.request));
        }
        catch (error) {
            notify("blocked");
            throw error;
        }
        let result;
        try {
            result = apply(original, receiver, args);
        }
        catch (error) {
            notify("threw");
            throw error;
        }
        notify(result === false ? "rejected" : "returned");
        return result;
    }
    let observedDefine;
    let observedFreeze;
    try {
        arrayEach(slots, slot => {
            const object = slot[0];
            const key = slot[1];
            const property = descriptor(object, key);
            const original = property.value;
            const operation = `${object === Object ? "Object" : object === Reflect ? "Reflect" : "Object.prototype"}.${key}`;
            const value = new Proxy(original, {
                /** 转发到带观察的反射调用。 */
                apply(target, receiver, args) {
                    return invoke(operation, target, receiver, args);
                },
            });
            define(object, key, { ...property, value });
            arrayPush(patches, { object, key, value, original: property });
            if (object === Object && key === "defineProperty")
                observedDefine = value;
            if (object === Object && key === "freeze")
                observedFreeze = value;
        });
    }
    catch (error) {
        arrayEach(patches, patch => define(patch.object, patch.key, patch.original));
        throw error;
    }
    // 直接保存已安装的包装器，不依赖业务可修改的全局属性。
    const releaseReflection = bindReflection({
        defineProperty: observedDefine,
        freeze: observedFreeze,
    });
    return {
        /** 登记对象监听，返回取消函数。 */
        track(object, listener, key) {
            if (closed)
                return () => { };
            let entries = weakMapGet(registrations, object);
            if (!entries)
                weakMapSet(registrations, object, (entries = newSet()));
            const item = {
                listener: {
                    before: descriptor(listener, "before")?.value,
                    after: descriptor(listener, "after")?.value,
                },
                key: typeof key === "number" ? string(key) : key,
            };
            setAdd(entries, item);
            return () => setDelete(entries, item);
        },
        targets: () => arrayMap(patches, ({ object, key, value }) => ({ object, key, value })),
        /** 停止观察并恢复反射入口。 */
        close() {
            if (closed)
                return;
            closed = true;
            arrayEach(patches, patch => {
                const current = descriptor(patch.object, patch.key);
                if (current?.value === patch.value && (current.configurable || current.writable))
                    define(patch.object, patch.key, patch.original);
            });
            releaseReflection();
        },
    };
}
//# sourceMappingURL=watch.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("monitor/watch.ts", { installHookWatch })
