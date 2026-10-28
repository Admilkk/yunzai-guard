import { types } from "node:util";
import { M } from "../shared/messages.js";
/** 未知集合实例不能提供可执行的自有迭代器或方法钩子。 */
export function nativeCollection(value, prototype) {
    return Boolean(value &&
        typeof value === "object" &&
        !types.isProxy(value) &&
        Object.getPrototypeOf(value) === prototype &&
        Reflect.ownKeys(value).length === 0);
}
/** 读取已知的守护进程自有记录，不执行继承方法或访问器钩子。 */
export function ownData(object, key) {
    if (types.isProxy(object))
        throw new Error(M.pm2.proxyRecord);
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor && !("value" in descriptor))
        throw new Error(M.pm2.accessorRecord);
    return descriptor?.value;
}
/** 读取对象上 Symbol 键的自有登记记录。 */
export function ownRegistry(object, key) {
    const value = ownData(object, key);
    if (value === undefined) {
        if (Reflect.has(object, key))
            throw new Error(M.pm2.inheritedRegistry);
        return undefined;
    }
    if (!value ||
        typeof value !== "object" ||
        types.isProxy(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw new Error(M.pm2.registryRecord);
    for (const name of Reflect.ownKeys(value))
        ownData(value, name);
    return value;
}
/** 确认对象指定自有属性可写。 */
export function writableOwn(object, keys) {
    if (types.isProxy(object))
        throw new Error(M.pm2.proxyRecord);
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.writable)
            throw new Error(M.pm2.lineageData);
    }
}
/**
 * 写入前检查所有待替换项的描述符。同步提交期间不执行 getter、await 或 PM2 回调；
 * 已知旧验证器看到的 God 与记录指针保持匹配，
 * 其真实原始闭包也继续保留。
 */
export function replaceOwnedValues(changes) {
    const snapshots = changes.map(change => {
        writableOwn(change.object, [change.key]);
        const descriptor = Object.getOwnPropertyDescriptor(change.object, change.key);
        if (descriptor.value !== change.previous)
            throw new Error(M.pm2.methodLineage);
        return { ...change, descriptor };
    });
    let committed = 0;
    try {
        for (const change of snapshots) {
            Object.defineProperty(change.object, change.key, { ...change.descriptor, value: change.next });
            committed++;
        }
    }
    catch (error) {
        for (const change of snapshots.slice(0, committed).reverse())
            Object.defineProperty(change.object, change.key, change.descriptor);
        throw error;
    }
}
/** 跨越系统观察器的 await 时，固定注册表容器、指针及描述符身份。 */
export function captureOwnRecords(records, selected) {
    const snapshots = records
        .filter((value) => value !== undefined)
        .map(object => {
        const keys = selected ?? Reflect.ownKeys(object);
        const descriptors = keys.map(key => {
            ownData(object, key);
            const descriptor = Object.getOwnPropertyDescriptor(object, key);
            if (!descriptor)
                throw new Error(M.pm2.registryLineageMissing);
            return { key, descriptor };
        });
        return { object, descriptors };
    });
    return () => {
        for (const { object, descriptors } of snapshots) {
            if (!selected && Reflect.ownKeys(object).length !== descriptors.length)
                throw new Error(M.pm2.registryLineage);
            for (const { key, descriptor: previous } of descriptors) {
                ownData(object, key);
                const current = Object.getOwnPropertyDescriptor(object, key);
                if (!current ||
                    current.value !== previous.value ||
                    current.writable !== previous.writable ||
                    current.configurable !== previous.configurable ||
                    current.enumerable !== previous.enumerable)
                    throw new Error(M.pm2.registryLineage);
            }
        }
    };
}
//# sourceMappingURL=legacy-sidecar.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("pm2/legacy-sidecar.ts", { nativeCollection, ownData, ownRegistry, writableOwn, replaceOwnedValues, captureOwnRecords })
