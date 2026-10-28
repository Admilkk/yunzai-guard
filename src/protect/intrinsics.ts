/** 在业务插件加载前捕获入口，仅供 Guard 内部调用，不冻结业务内建对象。 */
const call = Reflect.apply
const ObjectClass = Object
const MapClass = Map
const SetClass = Set
const WeakMapClass = WeakMap
const WeakSetClass = WeakSet
const PromiseClass = Promise
const ErrorClass = Error
const StringClass = String
const DateClass = Date
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
  mapSize: Object.getOwnPropertyDescriptor(Map.prototype, "size")!.get!,
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
}

/** 使用预先捕获的 Reflect.apply 调用函数。 */
export const apply = (fn: Function, receiver: unknown, args: ArrayLike<unknown>): any =>
  call(fn, receiver, args)
/** 内部描述符只采用自有字段，隔绝 Object.prototype 上的同名属性。 */
function cleanDescriptor(descriptor: PropertyDescriptor): PropertyDescriptor {
  const clean = captures.create(null) as PropertyDescriptor
  const fields = ["value", "get", "set", "writable", "enumerable", "configurable"] as const
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]
    if (call(captures.hasOwn, descriptor, [field])) clean[field] = captures.get(descriptor, field)
  }
  return clean
}
/** 使用清洗后的描述符定义属性。 */
export const objectDefine: typeof Object.defineProperty = (object, key, descriptor) =>
  captures.define(object, key, cleanDescriptor(descriptor))
/** 使用捕获的 Object.create 创建对象。 */
export const objectCreate: typeof Object.create = (...args: unknown[]) =>
  call(captures.create, undefined, args)
/** 判断对象是否有自有属性。 */
export const objectHasOwn = (object: object, key: PropertyKey): boolean =>
  call(captures.hasOwn, object, [key])
/** 判断值是否为对象或函数（可持有属性的引用）。 */
export const isReference = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function"
const descriptorFields = ["value", "get", "set", "writable", "enumerable", "configurable"] as const
/** 逐字段比较两个描述符；两者都缺失时视为相同。 */
export function sameDescriptor(a?: PropertyDescriptor, b?: PropertyDescriptor): boolean {
  if (!a || !b) return a === b
  for (let index = 0; index < descriptorFields.length; index++) {
    const field = descriptorFields[index]
    if (a[field] !== b[field]) return false
  }
  return true
}
/** 读取清洗后的自有属性描述符。 */
export function objectDescriptor(object: object, key: PropertyKey): PropertyDescriptor | undefined {
  const descriptor = captures.descriptor(object, key)
  return descriptor && cleanDescriptor(descriptor)
}
/** 读取全部清洗后的自有属性描述符。 */
export function objectDescriptors(object: object): Record<PropertyKey, PropertyDescriptor> {
  const result = captures.create(null) as Record<PropertyKey, PropertyDescriptor>
  const keys = captures.ownKeys(object)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    const descriptor = objectDescriptor(object, key)
    if (descriptor) result[key] = descriptor
  }
  return result
}
/** 冻结对象。 */
export const objectFreeze = <T>(object: T): Readonly<T> => captures.freeze(object)
/** 列出自有可枚举键值对。 */
export const objectEntries = <T>(object: Record<string, T>): [string, T][] =>
  captures.entries(object)
/** 列出自有可枚举值。 */
export const objectValues = <T>(object: Record<string, T>): T[] => captures.values(object)
/** 列出自有可枚举键。 */
export const objectKeys = (object: object) => captures.keys(object)
/** 读取原型。 */
export const objectPrototype = (object: object) => captures.prototype(object)
/** 判断对象是否可扩展。 */
export const objectExtensible = (object: object) => captures.extensible(object)
/** 列出自有 Symbol 键。 */
export const objectSymbols = (object: object) => captures.symbols(object)
/** 列出全部自有键。 */
export const ownKeys = (object: object) => captures.ownKeys(object)
/** 读取属性值。 */
export const reflectGet = (object: object, key: PropertyKey) => captures.get(object, key)
/** 返回原始 Object.prototype。 */
export const objectBase = (): object => ObjectClass.prototype
/** 解析 JSON。 */
export const jsonParse: typeof JSON.parse = (text, reviver) => captures.parse(text, reviver)
/** 序列化为 JSON。 */
export const jsonStringify: typeof JSON.stringify = (...args: unknown[]) =>
  call(captures.stringify, undefined, args)
/** 转换为字符串。 */
export const string = (value: unknown): string => StringClass(value)
/** 创建原始 Error。 */
export const error = (message: string): Error => new ErrorClass(message)
/** 判断是否为整数。 */
export const numberIsInteger = (value: unknown): boolean => captures.integer(value)
/** 判断是否为安全整数。 */
export const numberIsSafeInteger = (value: unknown): boolean => captures.safeInteger(value)
/** 判断是否为有限数。 */
export const numberIsFinite = (value: unknown): boolean => captures.finite(value)
/** 判断正则是否匹配。 */
export const regexpTest = (expression: RegExp, value: string): boolean =>
  call(captures.exec, expression, [value]) !== null
/** 计算字符串字节长度。 */
export const bufferByteLength: typeof Buffer.byteLength = (...args: unknown[]) =>
  call(captures.byteLength, undefined, args)
/** 取最小值。 */
export const mathMin = (...values: number[]): number => call(captures.min, undefined, values)
/** 取最大值。 */
export const mathMax = (...values: number[]): number => call(captures.max, undefined, values)
/** 返回当前时间的 ISO 字符串。 */
export const timestamp = (): string => call(captures.iso, new DateClass(), [])

/** 判断字符串前缀。 */
export const stringStartsWith = (value: string, prefix: string): boolean =>
  call(captures.startsWith, value, [prefix])
/** 判断字符串后缀。 */
export const stringEndsWith = (value: string, suffix: string): boolean =>
  call(captures.endsWith, value, [suffix])
/** 截取字符串。 */
export const stringSlice = (value: string, start: number, end?: number): string =>
  call(captures.slice, value, [start, end])
/** 按分隔符拆分字符串，不经过可替换的 split。 */
export function stringSplit(value: string, separator: string): string[] {
  const result: string[] = []
  if (!separator) {
    for (let index = 0; index < value.length; index++) arrayPush(result, value[index])
    return result
  }
  let cursor = 0
  let next: number
  while ((next = call(captures.indexOf, value, [separator, cursor])) >= 0) {
    arrayPush(result, stringSlice(value, cursor, next))
    cursor = next + separator.length
  }
  arrayPush(result, stringSlice(value, cursor))
  return result
}
/** 转为小写。 */
export const stringLower = (value: string): string => call(captures.lower, value, [])
/** 查找子串位置。 */
export const stringIndexOf = (value: string, search: string): number =>
  call(captures.indexOf, value, [search])

// 内部数组均为密集数组，索引遍历不读取可被业务替换的迭代器或 species。
/** 判断是否为数组。 */
export const arrayIsArray = (value: unknown): value is unknown[] => captures.array(value)
/** 按索引遍历数组。 */
export function arrayEach<T>(values: readonly T[], visit: (value: T, index: number) => void): void {
  for (let index = 0; index < values.length; index++) visit(values[index], index)
}
/** 按索引映射数组。 */
export function arrayMap<T, U>(values: readonly T[], visit: (value: T, index: number) => U): U[] {
  const result: U[] = []
  arrayEach(values, (value, index) => {
    arrayPush(result, visit(value, index))
  })
  return result
}
/** 判断是否存在满足条件的元素。 */
export function arraySome<T>(
  values: readonly T[],
  visit: (value: T, index: number) => boolean,
): boolean {
  for (let index = 0; index < values.length; index++) if (visit(values[index], index)) return true
  return false
}
/** 判断数组是否包含元素，NaN 视为相等。 */
export const arrayIncludes = <T>(values: readonly T[], item: T): boolean =>
  arraySome(values, value => value === item || (value !== value && item !== item))
/** 判断是否全部元素满足条件。 */
export const arrayEvery = <T>(
  values: readonly T[],
  visit: (value: T, index: number) => boolean,
): boolean => !arraySome(values, (value, index) => !visit(value, index))
/** 按条件过滤数组。 */
export function arrayFilter<T>(
  values: readonly T[],
  visit: (value: T, index: number) => boolean,
): T[] {
  const result: T[] = []
  arrayEach(values, (value, index) => {
    if (visit(value, index)) arrayPush(result, value)
  })
  return result
}
/** 移除并返回首个元素。 */
export function arrayShift<T>(values: T[]): T | undefined {
  if (!values.length) return undefined
  const first = values[0]
  for (let index = 1; index < values.length; index++) values[index - 1] = values[index]!
  values.length--
  return first
}
/** 以定义属性的方式追加元素，不触发可替换的 setter。 */
export const arrayPush = <T>(values: T[], value: T): void => {
  objectDefine(values, StringClass(values.length), {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  })
}
/** 复制数组片段。 */
export function arraySlice<T>(values: readonly T[], start = 0, end = values.length): T[] {
  const result: T[] = []
  for (let index = start; index < end; index++) arrayPush(result, values[index])
  return result
}

/** 创建 Map。 */
export const newMap = <K, V>(): Map<K, V> => new MapClass<K, V>()
/** 读取 Map 项。 */
export const mapGet = <K, V>(map: Map<K, V>, key: K): V | undefined =>
  call(captures.mapGet, map, [key])
/** 写入 Map 项。 */
export const mapSet = <K, V>(map: Map<K, V>, key: K, value: V): void => {
  call(captures.mapSet, map, [key, value])
}
/** 判断 Map 是否有键。 */
export const mapHas = <K, V>(map: Map<K, V>, key: K): boolean => call(captures.mapHas, map, [key])
/** 删除 Map 项。 */
export const mapDelete = <K, V>(map: Map<K, V>, key: K): boolean =>
  call(captures.mapDelete, map, [key])
/** 清空 Map。 */
export const mapClear = (map: Map<unknown, unknown>): void => {
  call(captures.mapClear, map, [])
}
/** 遍历 Map。 */
export const mapEach = <K, V>(map: Map<K, V>, visit: (value: V, key: K) => void): void => {
  call(captures.mapEach, map, [visit])
}
/** 读取 Map 大小。 */
export const mapSize = (map: Map<unknown, unknown>): number => call(captures.mapSize, map, [])
/** 创建 Set。 */
export const newSet = <T>(): Set<T> => new SetClass<T>()
/** 向 Set 添加值。 */
export const setAdd = <T>(set: Set<T>, value: T): void => {
  call(captures.setAdd, set, [value])
}
/** 判断 Set 是否有值。 */
export const setHas = <T>(set: Set<T>, value: T): boolean => call(captures.setHas, set, [value])
/** 从 Set 删除值。 */
export const setDelete = <T>(set: Set<T>, value: T): boolean =>
  call(captures.setDelete, set, [value])
/** 遍历 Set。 */
export const setEach = <T>(set: Set<T>, visit: (value: T) => void): void => {
  call(captures.setEach, set, [visit])
}
/** 创建 WeakMap。 */
export const newWeakMap = <K extends object, V>(): WeakMap<K, V> => new WeakMapClass<K, V>()
/** 读取 WeakMap 项。 */
export const weakMapGet = <K extends object, V>(map: WeakMap<K, V>, key: K): V | undefined =>
  call(captures.weakMapGet, map, [key])
/** 写入 WeakMap 项。 */
export const weakMapSet = <K extends object, V>(map: WeakMap<K, V>, key: K, value: V): void => {
  call(captures.weakMapSet, map, [key, value])
}
/** 判断 WeakMap 是否有键。 */
export const weakMapHas = <K extends object, V>(map: WeakMap<K, V>, key: K): boolean =>
  call(captures.weakMapHas, map, [key])
/** 删除 WeakMap 项。 */
export const weakMapDelete = <K extends object, V>(map: WeakMap<K, V>, key: K): boolean =>
  call(captures.weakMapDelete, map, [key])
/** 创建 WeakSet。 */
export const newWeakSet = <T extends object>(): WeakSet<T> => new WeakSetClass<T>()
/** 向 WeakSet 添加值。 */
export const weakSetAdd = <T extends object>(set: WeakSet<T>, value: T): void => {
  call(captures.weakSetAdd, set, [value])
}
/** 判断 WeakSet 是否有值。 */
export const weakSetHas = <T extends object>(set: WeakSet<T>, value: T): boolean =>
  call(captures.weakSetHas, set, [value])
/** 创建已解决的 Promise。 */
export const promiseResolve = <T>(value: T | PromiseLike<T>): Promise<Awaited<T>> =>
  call(captures.resolve, PromiseClass, [value]) as Promise<Awaited<T>>
/** 创建已拒绝的 Promise。 */
export const promiseReject = (reason: unknown): Promise<never> =>
  call(captures.reject, PromiseClass, [reason])
/** 注册 Promise 回调。 */
export const promiseThen = <T, U>(
  promise: Promise<T>,
  visit: (value: T) => U | PromiseLike<U>,
  rejected?: (reason: unknown) => U | PromiseLike<U>,
): Promise<U> => call(captures.then, promise, [visit, rejected])
