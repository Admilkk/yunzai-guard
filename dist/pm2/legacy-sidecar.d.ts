/** 未知集合实例不能提供可执行的自有迭代器或方法钩子。 */
export declare function nativeCollection(value: unknown, prototype: object): boolean;
/** 读取已知的守护进程自有记录，不执行继承方法或访问器钩子。 */
export declare function ownData(object: object, key: PropertyKey): unknown;
/** 读取对象上 Symbol 键的自有登记记录。 */
export declare function ownRegistry<T extends object>(object: object, key: symbol): T | undefined;
/** 确认对象指定自有属性可写。 */
export declare function writableOwn(object: object, keys: PropertyKey[]): void;
interface Replacement {
    object: object;
    key: PropertyKey;
    previous: unknown;
    next: unknown;
}
/**
 * 写入前检查所有待替换项的描述符。同步提交期间不执行 getter、await 或 PM2 回调；
 * 已知旧验证器看到的 God 与记录指针保持匹配，
 * 其真实原始闭包也继续保留。
 */
export declare function replaceOwnedValues(changes: Replacement[]): void;
/** 跨越系统观察器的 await 时，固定注册表容器、指针及描述符身份。 */
export declare function captureOwnRecords(records: (object | undefined)[], selected?: PropertyKey[]): () => void;
export {};
