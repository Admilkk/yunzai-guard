import { performance } from "node:perf_hooks"
import { types } from "node:util"
import { nativeIdentityLimits, NativeIdentityError } from "./protocol.js"
import type {
  NativeIdentity,
  RefusalCode,
  NativeFailureResult,
  QualifiedNodeProfile,
} from "./protocol.js"

type ObjectValue = Record<string, unknown>
const refusalCodes = new Set<RefusalCode>([
  "UNSUPPORTED_PLATFORM_OR_ARCH",
  "UNSUPPORTED_NODE_PROFILE",
  "NATIVE_PRIMITIVE_UNAVAILABLE",
  "ACCESS_DENIED",
  "ROOT_OR_PARENT_CHANGED",
  "IDENTITY_UNKNOWN",
  "RELATIONSHIP_UNKNOWN",
  "SIGNAL_HANDLER_UNAVAILABLE_OR_UNKNOWN",
  "INSPECTOR_ACTIVATION_DISABLED",
  "ACTIVATION_ALREADY_ATTEMPTED",
  "STATE_OR_REQUEST_INVALID",
  "FRAME_OR_SCOPE_LIMIT",
  "DEADLINE",
  "NATIVE_OPERATION_UNKNOWN",
])
/** 抛出原生身份错误。 */
function fail(
  code: RefusalCode = "STATE_OR_REQUEST_INVALID",
  result: NativeFailureResult = "unknown",
): never {
  throw new NativeIdentityError(code, result)
}
/** 校验为非 Proxy 的普通对象。 */
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) fail()
  return value as ObjectValue
}
/** 校验必需与可选字段。 */
const keys = (value: ObjectValue, required: string[], optional: string[] = []): void => {
  if (
    required.some(key => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))
  )
    fail()
}
/** 校验正整数并检查上限。 */
const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) fail()
  return Number(value)
}
/** 校验指定字节长度的十六进制令牌。 */
const token = (value: unknown, bytes = 16): string => {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${bytes * 2}}$`).test(value)) fail()
  return value
}
/** 校验十进制数字字符串。 */
const decimal = (value: unknown): string => {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,39}$/.test(value)) fail("IDENTITY_UNKNOWN")
  return value
}
/** 以 JSON 文本比较两个值。 */
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
/** 返回距截止时间的剩余毫秒数。 */
const remaining = (deadline: number): number => {
  const value = Math.ceil(deadline - performance.now())
  if (value < 1) fail("DEADLINE")
  return value
}

/** 使用受限的小型解码器，并额外拒绝 JSON.parse 不会拒绝的重复对象键。 */
export function parseNativeIdentityJson(text: string): unknown {
  if (Buffer.byteLength(text) > nativeIdentityLimits.frameBytes) fail("FRAME_OR_SCOPE_LIMIT")
  let at = 0
  const whitespace = () => {
    while (/[ \r\n\t]/.test(text[at] ?? "") && at < text.length) at++
  }
  const value = (depth: number): unknown => {
    if (depth > 16) fail("FRAME_OR_SCOPE_LIMIT")
    whitespace()
    if (text[at] === '"') {
      const start = at++
      while (at < text.length) {
        const c = text[at++]
        if (c === "\\") {
          at++
          continue
        }
        if (c === '"') {
          const result: unknown = JSON.parse(text.slice(start, at))
          if (typeof result !== "string" || result.length > 4096) fail("FRAME_OR_SCOPE_LIMIT")
          return result
        }
      }
      fail()
    }
    if (text[at] === "{") {
      at++
      const result: ObjectValue = Object.create(null)
      whitespace()
      if (text[at] === "}") {
        at++
        return result
      }
      while (at < text.length) {
        const key = value(depth + 1)
        if (typeof key !== "string" || Object.hasOwn(result, key)) fail()
        whitespace()
        if (text[at++] !== ":") fail()
        result[key] = value(depth + 1)
        whitespace()
        const end = text[at++]
        if (end === "}") return result
        if (end !== ",") fail()
      }
      fail()
    }
    if (text[at] === "[") {
      at++
      const result: unknown[] = []
      whitespace()
      if (text[at] === "]") {
        at++
        return result
      }
      while (at < text.length) {
        if (result.length >= 1024) fail("FRAME_OR_SCOPE_LIMIT")
        result.push(value(depth + 1))
        whitespace()
        const end = text[at++]
        if (end === "]") return result
        if (end !== ",") fail()
      }
      fail()
    }
    for (const [literal, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(literal, at)) {
        at += literal.length
        return result
      }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(at))
    if (!match) fail()
    at += match[0].length
    const result = Number(match[0])
    if (!Number.isFinite(result)) fail()
    return result
  }
  try {
    const result = value(0)
    whitespace()
    if (at !== text.length) fail()
    return result
  } catch (error) {
    if (error instanceof NativeIdentityError) throw error
    return fail()
  }
}

/** 解析并校验原生进程身份。 */
export function parseNativeIdentity(value: unknown): NativeIdentity {
  const item = object(value)
  keys(item, ["pid", "birth"])
  const pid = integer(item.pid, 2147483647)
  if (pid <= 1) fail("IDENTITY_UNKNOWN")
  const birth = object(item.birth)
  if (birth.kind === "windows-filetime-100ns") {
    keys(birth, ["kind", "value"])
    return { pid, birth: { kind: birth.kind, value: decimal(birth.value) } }
  }
  if (birth.kind === "linux-proc-start-ticks") {
    keys(birth, ["kind", "value", "bootId", "pidNamespace"])
    if (
      typeof birth.bootId !== "string" ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(birth.bootId) ||
      typeof birth.pidNamespace !== "string" ||
      !/^[0-9]{1,20}:[0-9]{1,20}$/.test(birth.pidNamespace)
    )
      fail("IDENTITY_UNKNOWN")
    return {
      pid,
      birth: {
        kind: birth.kind,
        value: decimal(birth.value),
        bootId: birth.bootId,
        pidNamespace: birth.pidNamespace,
      },
    }
  }
  return fail("IDENTITY_UNKNOWN")
}

/** 解析并校验合格的 Node 运行时配置。 */
function profile(value: unknown): QualifiedNodeProfile {
  const item = object(value)
  keys(item, ["id", "platform", "architecture", "verification", "inspectorActivation"])
  if (
    typeof item.id !== "string" ||
    !/^[a-zA-Z0-9._-]{1,160}$/.test(item.id) ||
    item.platform !== process.platform ||
    item.architecture !== process.arch ||
    item.verification !== "qualified-target-image" ||
    item.inspectorActivation !==
      (process.platform === "win32"
        ? "windows-held-handle-debug-mapping"
        : "linux-held-pidfd-sigusr1-under-trusted-stable-handler")
  )
    fail("UNSUPPORTED_NODE_PROFILE")
  return item as unknown as QualifiedNodeProfile
}

export { refusalCodes, fail, object, keys, integer, token, decimal, equal, remaining, profile }
export type { ObjectValue }
