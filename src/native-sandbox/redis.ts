import type { NativeRedisPermissions } from "./types.js"
import { nativeRedisReservedPrefixes, parseNativeRedisPermissions } from "./config.js"
import { performance } from "node:perf_hooks"
import { M } from "../shared/messages.js"

type Command = { access: "read" | "write" | "both"; min: number; max: number }
const commands: Readonly<Record<string, Command>> = {
  get: { access: "read", min: 1, max: 1 },
  exists: { access: "read", min: 1, max: 256 },
  ttl: { access: "read", min: 1, max: 1 },
  pTTL: { access: "read", min: 1, max: 1 },
  hGet: { access: "read", min: 2, max: 2 },
  hGetAll: { access: "read", min: 1, max: 1 },
  hExists: { access: "read", min: 2, max: 2 },
  sMembers: { access: "read", min: 1, max: 1 },
  sIsMember: { access: "read", min: 2, max: 2 },
  lRange: { access: "read", min: 3, max: 3 },
  set: { access: "write", min: 2, max: 3 },
  expire: { access: "write", min: 2, max: 3 },
  pExpire: { access: "write", min: 2, max: 3 },
  hSet: { access: "write", min: 2, max: 3 },
  hDel: { access: "write", min: 2, max: 2 },
  sAdd: { access: "write", min: 2, max: 2 },
  sRem: { access: "write", min: 2, max: 2 },
  lPush: { access: "write", min: 2, max: 2 },
  rPush: { access: "write", min: 2, max: 2 },
  del: { access: "write", min: 1, max: 256 },
  incr: { access: "both", min: 1, max: 1 },
  decr: { access: "both", min: 1, max: 1 },
  incrBy: { access: "both", min: 2, max: 2 },
  decrBy: { access: "both", min: 2, max: 2 },
  lPop: { access: "both", min: 1, max: 1 },
  rPop: { access: "both", min: 1, max: 1 },
  keys: { access: "read", min: 1, max: 1 },
  zRange: { access: "read", min: 3, max: 4 },
  zRangeWithScores: { access: "read", min: 3, max: 4 },
  zRevRank: { access: "read", min: 2, max: 2 },
  zAdd: { access: "write", min: 2, max: 3 },
  zRem: { access: "write", min: 2, max: 2 },
}

/** 抛出 Redis 授权拒绝错误。 */
function denied(message: string): never {
  throw Object.assign(new Error(message), { code: "NATIVE_REDIS_DENIED" })
}

/** 判断键是否匹配通配模式。 */
const matches = (pattern: string, key: string): boolean =>
  pattern.endsWith("*") ? key.startsWith(pattern.slice(0, -1)) : key === pattern
/** 判断键是否被任一模式允许。 */
const permits = (patterns: string[], key: string): boolean =>
  patterns.some(pattern => matches(pattern, key))
/** 限制范围查询的跨度。 */
function boundedRange(start: unknown, end: unknown): void {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    Number(start) < 0 !== Number(end) < 0 ||
    Math.max(0, Number(end) - Number(start) + 1) > 256
  )
    denied("Redis range requires at most 256 entries without mixed positive/negative indexes")
}
/** 校验选项对象。 */
function optionsObject(value: unknown, allowed: string[]): Record<string, unknown> {
  if (value === undefined || value === null) return Object.create(null)
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !allowed.includes(key))
  )
    denied("Unsupported Redis options")
  return value as Record<string, unknown>
}
/** 校验集合成员。 */
function member(value: unknown): void {
  if (typeof value !== "string" || value.length > 2048 || Buffer.byteLength(value) > 2048)
    denied("Sorted-set members must be strings of at most 2048 bytes")
}

/** 计算字符串字节长度。 */
function stringBytes(value: string): number {
  if (value.length > 65536) denied("Redis result exceeds 64 KiB")
  let size = Buffer.byteLength(value) + 2
  for (let index = 0; index < value.length; index++) {
    const char = value.charCodeAt(index)
    if (char === 34 || char === 92) size++
    else if (char < 32) size += [8, 9, 10, 12, 13].includes(char) ? 1 : 5
    else if (
      char >= 0xd800 &&
      char <= 0xdbff &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    )
      index++
    else if (char >= 0xd800 && char <= 0xdfff) size += 3
  }
  return size
}

/** DTO 复制和 JSON 编码前拒绝超大结果；此时 Redis 客户端已接收到数据。 */
export function validateNativeRedisResult(value: unknown): void {
  let size = 0,
    nodes = 0
  const seen = new Set<object>()
  const add = (amount: number) => {
    size += amount
    if (size > 65536) denied("Redis result exceeds 64 KiB")
  }
  const visit = (item: unknown, depth = 0): void => {
    if (++nodes > 2048 || depth > 12) denied("Redis result exceeds its structural limit")
    if (typeof item === "string") {
      add(stringBytes(item))
      return
    }
    if (item == null) {
      add(4)
      return
    }
    if (typeof item === "boolean") {
      add(5)
      return
    }
    if (typeof item === "number" && Number.isFinite(item)) {
      add(String(item).length)
      return
    }
    if (!item || typeof item !== "object" || seen.has(item))
      denied("Redis result is not bounded JSON data")
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
      denied("Redis result must contain plain JSON objects")
    seen.add(item)
    add(2)
    try {
      if (Array.isArray(item)) {
        if (item.length > 256) denied("Redis result arrays support at most 256 entries")
        for (let index = 0; index < item.length; index++) {
          const property = Object.getOwnPropertyDescriptor(item, String(index))
          if (!property || !Object.hasOwn(property, "value"))
            denied("Redis result accessors are forbidden")
          add(1)
          visit(property.value, depth + 1)
        }
      } else {
        let properties = 0
        for (const key in item) {
          if (!Object.hasOwn(item, key)) continue
          if (++properties > 256) denied("Redis result objects support at most 256 fields")
          const property = Object.getOwnPropertyDescriptor(item, key)!
          if (
            !Object.hasOwn(property, "value") ||
            ["__proto__", "constructor", "prototype"].includes(key)
          )
            denied("Redis result contains an unsafe property")
          add(stringBytes(key) + 2)
          visit(property.value, depth + 1)
        }
      }
    } finally {
      seen.delete(item)
    }
  }
  visit(value)
}

/** 仅克隆有界数据，在调用 Redis 客户端或类型转换前拒绝访问器。 */
function argumentsCopy(input: unknown[]): unknown[] {
  let size = 0,
    nodes = 0
  const copy = (value: unknown, depth = 0): unknown => {
    if (++nodes > 2048 || depth > 12) denied("Redis arguments exceed their structural limit")
    if (typeof value === "string") {
      if (value.length > 65536) denied("Redis arguments exceed 64 KiB")
      size += Buffer.byteLength(value)
      if (size > 65536) denied("Redis arguments exceed 64 KiB")
      return value
    }
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return value
    if (!value || typeof value !== "object") denied("Redis arguments must be JSON data")
    if (Array.isArray(value)) {
      if (value.length > 256) denied("Redis arrays support at most 256 values")
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !Object.hasOwn(descriptor, "value"))
          denied("Redis argument accessors and sparse arrays are forbidden")
        return copy(descriptor.value, depth + 1)
      })
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      denied("Redis arguments must be plain JSON objects")
    const result: Record<string, unknown> = Object.create(null)
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (
        typeof key !== "string" ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        ["__proto__", "constructor", "prototype"].includes(key)
      )
        denied("Redis arguments contain an unsafe property")
      copy(key, depth + 1)
      result[key] = copy(descriptor.value, depth + 1)
    }
    return result
  }
  return copy(input) as unknown[]
}

/** 校验键名。 */
function keyName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    Buffer.byteLength(value) > 2048 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    denied("Redis keys must be bounded nonempty strings")
  if (nativeRedisReservedPrefixes.some(prefix => value.toLowerCase().startsWith(prefix)))
    denied("Guard Redis state is not exposed")
  return value
}

/** 准备使用原键名的单条命令，执行宿主命令前检查全部键。 */
export function prepareNativeRedisCommand(
  permissions: NativeRedisPermissions | undefined,
  method: string,
  input: unknown[],
): { method: string; args: unknown[] } {
  if (typeof method !== "string" || !Object.hasOwn(commands, method))
    denied("Redis command is not exposed; raw SCAN and arbitrary commands are unavailable")
  if (!Array.isArray(input)) denied("Redis arguments must be an array")
  const policy = parseNativeRedisPermissions(permissions)
  const command = commands[method]!
  if (input.length < command.min || input.length > command.max)
    denied("Invalid Redis command argument count")
  const args = argumentsCopy(input)
  if (method === "keys") {
    let pattern: string
    try {
      pattern = parseNativeRedisPermissions({ read: [args[0]] }).read[0]!
    } catch {
      denied("Redis key queries require one explicit exact key or literal prefix*")
    }
    const covered = pattern.endsWith("*")
      ? policy.read.some(
          grant => grant.endsWith("*") && pattern.slice(0, -1).startsWith(grant.slice(0, -1)),
        )
      : permits(policy.read, pattern)
    if (!covered) denied("Redis key query exceeds its read grants")
    return { method, args: [pattern] }
  }
  const multi = method === "del" || method === "exists"
  const keys = (
    multi ? (args.length === 1 && Array.isArray(args[0]) ? args[0] : args) : [args[0]]
  ).map(keyName)
  if (!keys.length || keys.length > 256)
    denied("Redis commands require between 1 and 256 explicit keys")
  let needRead = command.access === "read" || command.access === "both"
  const needWrite = command.access === "write" || command.access === "both"
  if (method === "set" && args[2] != null) {
    const options = args[2]
    if (!options || typeof options !== "object" || Array.isArray(options))
      denied("SET options must be a plain object")
    for (const [name, value] of Object.entries(options)) {
      if (["GET", "NX", "XX", "KEEPTTL"].includes(name)) {
        if (typeof value !== "boolean") denied("SET flags must be boolean")
      } else if (["EX", "PX", "EXAT", "PXAT"].includes(name)) {
        if (!Number.isSafeInteger(value) || Number(value) <= 0)
          denied("SET expiry must be a positive integer")
      } else denied("Unsupported SET option")
    }
    if ((options as Record<string, unknown>).GET === true) needRead = true
  }
  if (method === "lRange") {
    const [start, end] = args.slice(1)
    boundedRange(start, end)
  }
  if (method === "zRange" || method === "zRangeWithScores") {
    const options = optionsObject(args[3], ["BY", "REV", "LIMIT"])
    if (options.REV !== undefined && typeof options.REV !== "boolean")
      denied("Sorted-set REV must be boolean")
    if (options.BY === undefined) {
      if (options.LIMIT !== undefined) denied("Sorted-set LIMIT requires BY SCORE or LEX")
      boundedRange(args[1], args[2])
    } else {
      if (options.BY !== "SCORE" && options.BY !== "LEX")
        denied("Sorted-set BY must be SCORE or LEX")
      const limit = optionsObject(options.LIMIT, ["offset", "count"])
      if (
        !Number.isSafeInteger(limit.offset) ||
        Number(limit.offset) < 0 ||
        Number(limit.offset) > 10000 ||
        !Number.isSafeInteger(limit.count) ||
        Number(limit.count) < 1 ||
        Number(limit.count) > 256
      )
        denied("Sorted-set score/lex ranges require LIMIT count 1-256 and offset 0-10000")
      for (const bound of args.slice(1, 3)) {
        if (options.BY === "SCORE") {
          const text = typeof bound === "string" ? bound : ""
          if (
            !(typeof bound === "number" && Number.isFinite(bound)) &&
            !/^[+-]?inf$/i.test(text) &&
            !(
              text.length <= 128 &&
              /^\(?[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) &&
              Number.isFinite(Number(text.replace(/^\(/, "")))
            )
          )
            denied("Invalid sorted-set score bound")
        } else if (
          typeof bound !== "string" ||
          bound.length > 2048 ||
          !(bound === "+" || bound === "-" || bound.startsWith("[") || bound.startsWith("("))
        )
          denied("Invalid sorted-set lex bound")
      }
    }
  }
  if (method === "zAdd") {
    const members = Array.isArray(args[1]) ? args[1] : [args[1]]
    if (!members.length || members.length > 256) denied("ZADD requires at most 256 members")
    for (const value of members) {
      const entry = optionsObject(value, ["score", "value"])
      if (typeof entry.score !== "number" || !Number.isFinite(entry.score))
        denied("Sorted-set scores must be finite numbers")
      member(entry.value)
    }
    const options = optionsObject(args[2], ["NX", "XX", "GT", "LT", "CH", "INCR"])
    if (Object.values(options).some(value => typeof value !== "boolean"))
      denied("ZADD flags must be boolean")
    if (options.INCR) {
      needRead = true
      if (members.length !== 1) denied("ZADD INCR requires exactly one member")
    }
  }
  if (method === "zRem" || method === "zRevRank") {
    const members = method === "zRem" && Array.isArray(args[1]) ? args[1] : [args[1]]
    if (!members.length || members.length > 256)
      denied("Sorted-set operations support at most 256 members")
    for (const value of members) member(value)
  }
  for (const key of keys)
    if ((needRead && !permits(policy.read, key)) || (needWrite && !permits(policy.write, key)))
      denied("Redis key permission is missing")
  return { method, args: multi ? [keys] : args }
}

const scanLeases = new WeakMap<object, number>()
/** 在授权范围内扫描键。 */
async function scanKeys(
  target: object,
  permissions: NativeRedisPermissions | undefined,
  pattern: string,
): Promise<string[]> {
  const policy = parseNativeRedisPermissions(permissions)
  if (!pattern.endsWith("*")) {
    const exists = Reflect.get(target, "exists")
    if (typeof exists !== "function") denied("Redis EXISTS is unavailable")
    const found = await Reflect.apply(exists, target, [[pattern]])
    if (found !== 0 && found !== 1) denied("Invalid Redis EXISTS result")
    return found ? [pattern] : []
  }
  const scan = Reflect.get(target, "scan")
  if (typeof scan !== "function") denied("Redis SCAN is unavailable")
  const active = scanLeases.get(target) ?? 0
  if (active >= 2) denied("Redis key scan concurrency limit exceeded")
  scanLeases.set(target, active + 1)
  let expired = false
  const deadline = performance.now() + 1000
  const work = (async () => {
    let cursor: number | string = 0,
      bytes = 2
    const result = new Set<string>()
    for (let step = 0; step < 64; step++) {
      if (expired || performance.now() >= deadline) denied("Redis key scan deadline exceeded")
      const page = await Reflect.apply(scan, target, [cursor, { MATCH: pattern, COUNT: 100 }])
      if (expired || performance.now() >= deadline) denied("Redis key scan deadline exceeded")
      if (!page || typeof page !== "object") denied("Invalid Redis SCAN page")
      const rawCursor = Object.getOwnPropertyDescriptor(page, "cursor"),
        rawKeys = Object.getOwnPropertyDescriptor(page, "keys")
      if (
        !rawCursor ||
        !Object.hasOwn(rawCursor, "value") ||
        !rawKeys ||
        !Object.hasOwn(rawKeys, "value")
      )
        denied("Invalid Redis SCAN page")
      const next = rawCursor.value
      if (
        !(Number.isSafeInteger(next) && next >= 0) &&
        !(typeof next === "string" && /^(0|[1-9]\d{0,19})$/.test(next))
      )
        denied("Invalid Redis scan cursor")
      const keys = rawKeys.value
      if (!Array.isArray(keys) || keys.length > 256) denied("Redis key scan result limit exceeded")
      for (let index = 0; index < keys.length; index++) {
        const property = Object.getOwnPropertyDescriptor(keys, String(index))
        if (!property || !Object.hasOwn(property, "value")) denied("Invalid Redis scan key")
        const key = keyName(property.value)
        if (!matches(pattern, key) || !permits(policy.read, key))
          denied("Redis key scan returned an unauthorized key")
        if (!result.has(key)) {
          bytes += stringBytes(key) + 1
          if (result.size >= 256 || bytes > 65536) denied("Redis key scan result limit exceeded")
          result.add(key)
        }
      }
      cursor = next
      if (cursor === 0 || cursor === "0") return [...result]
    }
    denied("Redis key scan step limit exceeded")
  })().finally(() => {
    const count = scanLeases.get(target) ?? 1
    if (count <= 1) scanLeases.delete(target)
    else scanLeases.set(target, count - 1)
  })
  // 请求超时后仍占用槽位，直到实际 Redis Promise 完成。
  // 否则调用方反复超时会累积无限待处理宿主请求。
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true
          reject(
            Object.assign(new Error(M.nativeSandbox.redisScanTimeout), {
              code: "NATIVE_REDIS_DENIED",
            }),
          )
        }, 1000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** 执行沙箱请求的 Redis 命令，只允许授权键与命令。 */
export async function executeNativeRedis(
  target: unknown,
  permissions: NativeRedisPermissions | undefined,
  method: string,
  args: unknown[],
): Promise<unknown> {
  const request = prepareNativeRedisCommand(permissions, method, args)
  if (!target || typeof target !== "object") denied("Redis service is unavailable")
  if (request.method === "keys") return scanKeys(target, permissions, request.args[0] as string)
  const fn = Reflect.get(target, request.method)
  if (typeof fn !== "function") denied("Redis command is unavailable")
  const result = await Reflect.apply(fn, target, request.args)
  validateNativeRedisResult(result)
  return result
}
