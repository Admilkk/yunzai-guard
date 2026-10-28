/** 使用预先捕获的 Reflect.apply 调用函数。 */
export declare const apply: (fn: Function, receiver: unknown, args: ArrayLike<unknown>) => any;
/** 使用清洗后的描述符定义属性。 */
export declare const objectDefine: typeof Object.defineProperty;
/** 使用捕获的 Object.create 创建对象。 */
export declare const objectCreate: typeof Object.create;
/** 判断对象是否有自有属性。 */
export declare const objectHasOwn: (object: object, key: PropertyKey) => boolean;
/** 判断值是否为对象或函数（可持有属性的引用）。 */
export declare const isReference: (value: unknown) => value is object;
/** 逐字段比较两个描述符；两者都缺失时视为相同。 */
export declare function sameDescriptor(a?: PropertyDescriptor, b?: PropertyDescriptor): boolean;
/** 读取清洗后的自有属性描述符。 */
export declare function objectDescriptor(object: object, key: PropertyKey): PropertyDescriptor | undefined;
/** 读取全部清洗后的自有属性描述符。 */
export declare function objectDescriptors(object: object): Record<PropertyKey, PropertyDescriptor>;
/** 冻结对象。 */
export declare const objectFreeze: <T>(object: T) => Readonly<T>;
/** 列出自有可枚举键值对。 */
export declare const objectEntries: <T>(object: Record<string, T>) => [string, T][];
/** 列出自有可枚举值。 */
export declare const objectValues: <T>(object: Record<string, T>) => T[];
/** 列出自有可枚举键。 */
export declare const objectKeys: (object: object) => string[];
/** 读取原型。 */
export declare const objectPrototype: (object: object) => any;
/** 判断对象是否可扩展。 */
export declare const objectExtensible: (object: object) => boolean;
/** 列出自有 Symbol 键。 */
export declare const objectSymbols: (object: object) => symbol[];
/** 列出全部自有键。 */
export declare const ownKeys: (object: object) => (string | symbol)[];
/** 读取属性值。 */
export declare const reflectGet: (object: object, key: PropertyKey) => any;
/** 返回原始 Object.prototype。 */
export declare const objectBase: () => object;
/** 解析 JSON。 */
export declare const jsonParse: typeof JSON.parse;
/** 序列化为 JSON。 */
export declare const jsonStringify: typeof JSON.stringify;
/** 转换为字符串。 */
export declare const string: (value: unknown) => string;
/** 创建原始 Error。 */
export declare const error: (message: string) => Error;
/** 判断是否为整数。 */
export declare const numberIsInteger: (value: unknown) => boolean;
/** 判断是否为安全整数。 */
export declare const numberIsSafeInteger: (value: unknown) => boolean;
/** 判断是否为有限数。 */
export declare const numberIsFinite: (value: unknown) => boolean;
/** 判断正则是否匹配。 */
export declare const regexpTest: (expression: RegExp, value: string) => boolean;
/** 计算字符串字节长度。 */
export declare const bufferByteLength: typeof Buffer.byteLength;
/** 取最小值。 */
export declare const mathMin: (...values: number[]) => number;
/** 取最大值。 */
export declare const mathMax: (...values: number[]) => number;
/** 返回当前时间的 ISO 字符串。 */
export declare const timestamp: () => string;
/** 判断字符串前缀。 */
export declare const stringStartsWith: (value: string, prefix: string) => boolean;
/** 判断字符串后缀。 */
export declare const stringEndsWith: (value: string, suffix: string) => boolean;
/** 截取字符串。 */
export declare const stringSlice: (value: string, start: number, end?: number) => string;
/** 按分隔符拆分字符串，不经过可替换的 split。 */
export declare function stringSplit(value: string, separator: string): string[];
/** 转为小写。 */
export declare const stringLower: (value: string) => string;
/** 查找子串位置。 */
export declare const stringIndexOf: (value: string, search: string) => number;
/** 判断是否为数组。 */
export declare const arrayIsArray: (value: unknown) => value is unknown[];
/** 按索引遍历数组。 */
export declare function arrayEach<T>(values: readonly T[], visit: (value: T, index: number) => void): void;
/** 按索引映射数组。 */
export declare function arrayMap<T, U>(values: readonly T[], visit: (value: T, index: number) => U): U[];
/** 判断是否存在满足条件的元素。 */
export declare function arraySome<T>(values: readonly T[], visit: (value: T, index: number) => boolean): boolean;
/** 判断数组是否包含元素，NaN 视为相等。 */
export declare const arrayIncludes: <T>(values: readonly T[], item: T) => boolean;
/** 判断是否全部元素满足条件。 */
export declare const arrayEvery: <T>(values: readonly T[], visit: (value: T, index: number) => boolean) => boolean;
/** 按条件过滤数组。 */
export declare function arrayFilter<T>(values: readonly T[], visit: (value: T, index: number) => boolean): T[];
/** 移除并返回首个元素。 */
export declare function arrayShift<T>(values: T[]): T | undefined;
/** 以定义属性的方式追加元素，不触发可替换的 setter。 */
export declare const arrayPush: <T>(values: T[], value: T) => void;
/** 复制数组片段。 */
export declare function arraySlice<T>(values: readonly T[], start?: number, end?: number): T[];
/** 创建 Map。 */
export declare const newMap: <K, V>() => Map<K, V>;
/** 读取 Map 项。 */
export declare const mapGet: <K, V>(map: Map<K, V>, key: K) => V | undefined;
/** 写入 Map 项。 */
export declare const mapSet: <K, V>(map: Map<K, V>, key: K, value: V) => void;
/** 判断 Map 是否有键。 */
export declare const mapHas: <K, V>(map: Map<K, V>, key: K) => boolean;
/** 删除 Map 项。 */
export declare const mapDelete: <K, V>(map: Map<K, V>, key: K) => boolean;
/** 清空 Map。 */
export declare const mapClear: (map: Map<unknown, unknown>) => void;
/** 遍历 Map。 */
export declare const mapEach: <K, V>(map: Map<K, V>, visit: (value: V, key: K) => void) => void;
/** 读取 Map 大小。 */
export declare const mapSize: (map: Map<unknown, unknown>) => number;
/** 创建 Set。 */
export declare const newSet: <T>() => Set<T>;
/** 向 Set 添加值。 */
export declare const setAdd: <T>(set: Set<T>, value: T) => void;
/** 判断 Set 是否有值。 */
export declare const setHas: <T>(set: Set<T>, value: T) => boolean;
/** 从 Set 删除值。 */
export declare const setDelete: <T>(set: Set<T>, value: T) => boolean;
/** 遍历 Set。 */
export declare const setEach: <T>(set: Set<T>, visit: (value: T) => void) => void;
/** 创建 WeakMap。 */
export declare const newWeakMap: <K extends object, V>() => WeakMap<K, V>;
/** 读取 WeakMap 项。 */
export declare const weakMapGet: <K extends object, V>(map: WeakMap<K, V>, key: K) => V | undefined;
/** 写入 WeakMap 项。 */
export declare const weakMapSet: <K extends object, V>(map: WeakMap<K, V>, key: K, value: V) => void;
/** 判断 WeakMap 是否有键。 */
export declare const weakMapHas: <K extends object, V>(map: WeakMap<K, V>, key: K) => boolean;
/** 删除 WeakMap 项。 */
export declare const weakMapDelete: <K extends object, V>(map: WeakMap<K, V>, key: K) => boolean;
/** 创建 WeakSet。 */
export declare const newWeakSet: <T extends object>() => WeakSet<T>;
/** 向 WeakSet 添加值。 */
export declare const weakSetAdd: <T extends object>(set: WeakSet<T>, value: T) => void;
/** 判断 WeakSet 是否有值。 */
export declare const weakSetHas: <T extends object>(set: WeakSet<T>, value: T) => boolean;
/** 创建已解决的 Promise。 */
export declare const promiseResolve: <T>(value: T | PromiseLike<T>) => Promise<Awaited<T>>;
/** 创建已拒绝的 Promise。 */
export declare const promiseReject: (reason: unknown) => Promise<never>;
/** 注册 Promise 回调。 */
export declare const promiseThen: <T, U>(promise: Promise<T>, visit: (value: T) => U | PromiseLike<U>, rejected?: (reason: unknown) => U | PromiseLike<U>) => Promise<U>;
