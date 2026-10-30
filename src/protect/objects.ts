import { types } from "node:util"
import type { EmitEvent } from "../shared/types.js"
import type { HookWatch } from "../monitor/watch.js"

import * as intrinsics from "./intrinsics.js"
import {
  cleanDescriptor,
  objectDefine,
  objectDescriptors as descriptors,
  objectFreeze,
  ownKeys,
  objectDescriptor as getDescriptor,
  reflectGet as get,
  objectEntries as entries,
  objectValues as values,
  objectBase,
  string,
  error,
  newMap,
  mapSet,
  mapEach,
  newWeakSet,
  weakSetHas,
  weakSetAdd,
  newWeakMap,
  weakMapHas,
  weakMapGet,
  weakMapSet,
  arrayEach,
} from "./intrinsics.js"
import { M } from "../shared/messages.js"

// 自保护安装与加固需要绕开自身的观察器；原始反射入口仅保留在本模块闭包中。
const nativeDefine = Object.defineProperty
const freeze = Object.freeze
const define: typeof Object.defineProperty = (object, key, descriptor) =>
  nativeDefine(object, key, cleanDescriptor(descriptor))
const isProxy = types.isProxy
const registered = newMap<string, Record<string, unknown>>()
const hardened = newWeakSet<object>()
let emit: EmitEvent | undefined
let origin: (() => string | undefined) | undefined
let active = false
let reporting = false
let watch: HookWatch | undefined

/** 自保护不经过可配置业务规则，也不以日志成功作为拒绝条件。 */
export function refuse(operation: string, target: string): never {
  if (!reporting) {
    reporting = true
    try {
      emit?.({
        kind: "self-protection",
        operation,
        target,
        plugin: origin?.() ?? "unknown",
        action: "deny",
        details: { blocked: true, detection: "before-call" },
      })
    } catch {
      // 审计故障不能放行受保护操作。
    } finally {
      reporting = false
    }
  }
  const failure = error(M.protect.denied(operation, target))
  define(failure, "code", { value: "ERR_GUARD_SELF_PROTECTION" })
  throw failure
}

/** 仅固定 Guard 自有函数槽，不冻结整个 Node 模块或业务对象。 */
export function seal(
  object: object,
  key: PropertyKey,
  value: unknown,
  label = string(key),
  allowCopy = false,
): void {
  sealSlot(object, key, value, label, allowCopy, objectDefine)
}

/** 内部加固使用私有写入口；公开 seal 使用经过监控的写入口。 */
function sealSlot(
  object: object,
  key: PropertyKey,
  value: unknown,
  label: string,
  allowCopy: boolean,
  write: typeof Object.defineProperty,
): void {
  const descriptor = getDescriptor(object, key)
  if (descriptor && !descriptor.configurable) {
    if ("value" in descriptor && descriptor.value === value && !descriptor.writable) {
      harden(value, label)
      return
    }
    throw error(M.protect.alreadySealed(label))
  }
  const copies = newWeakMap<object, unknown>()
  const separate = (receiver: unknown): receiver is object =>
    allowCopy &&
    receiver !== object &&
    receiver !== null &&
    (typeof receiver === "object" || typeof receiver === "function")
  write(object, key, {
    configurable: false,
    enumerable: descriptor?.enumerable ?? true,
    /** 副本读取自身包装，原对象读取原始值。 */
    get(this: unknown) {
      return separate(this) && weakMapHas(copies, this) ? weakMapGet(copies, this) : value
    },
    /** 写入只作用于副本，不改写原始入口。 */
    set(this: unknown, next: unknown) {
      // graceful-fs 会复制描述符；副本的包装不能改写原始入口。
      if (separate(this)) weakMapSet(copies, this, next)
      else if (next !== value) refuse("function-hook", label)
    },
  })
  watch?.track(
    object,
    {
      before: request => {
        if (request.operation === "Reflect.set" && separate(request.receiver)) return
        refuse("function-hook", label)
      },
    },
    key,
  )
  harden(value, label)
}

/** 加固 Guard 自有函数及其原型，使其不可替换。 */
function harden(value: unknown, label: string): void {
  if (typeof value !== "function" || weakSetHas(hardened, value)) return
  weakSetAdd(hardened, value)
  // 代理构造器可能共享 Node 原型；只固定函数对象，不递归触碰底层原型。
  if (isProxy(value)) {
    freeze(value)
    watch?.track(value, { before: () => refuse("function-hook", label) })
    return
  }
  const properties = descriptors(value)
  arrayEach(ownKeys(properties), key => {
    const descriptor = get(properties, key) as PropertyDescriptor
    if (key === "prototype" && descriptor.value && descriptor.value !== objectBase()) {
      const prototype = descriptor.value as object
      if (!weakSetHas(hardened, prototype)) {
        weakSetAdd(hardened, prototype)
        arrayEach(ownKeys(prototype), name => {
          if (name === "constructor") return
          const member = getDescriptor(prototype, name)!
          if (typeof member.value === "function" && member.configurable) {
            sealSlot(
              prototype,
              name,
              member.value,
              `${label}.prototype.${string(name)}`,
              false,
              define,
            )
            harden(member.value, `${label}.${string(name)}`)
          }
        })
        freeze(prototype)
        watch?.track(prototype, { before: () => refuse("function-hook", `${label}.prototype`) })
      }
    } else if (typeof descriptor.value === "function" && descriptor.configurable) {
      sealSlot(value, key, descriptor.value, `${label}.${string(key)}`, false, define)
      harden(descriptor.value, `${label}.${string(key)}`)
    } else if (typeof descriptor.value === "function")
      harden(descriptor.value, `${label}.${string(key)}`)
  })
  freeze(value)
  watch?.track(value, { before: () => refuse("function-hook", label) })
}

/** 构建时为自有模块追加登记；稍后导入的模块也立即固定其函数。 */
export function registerModule(name: string, exports: Record<string, unknown>): void {
  mapSet(registered, name, exports)
  if (active) arrayEach(entries(exports), item => harden(item[1], `${name}:${item[0]}`))
}

/** 安装 Guard 自有对象的保护，并把篡改尝试上报为自保护事件。 */
export function protectObjects(
  deliver: EmitEvent,
  context?: () => string | undefined,
  observer?: HookWatch,
): void {
  if (active) refuse("runtime-reinstall", "guard-functions")
  emit = deliver
  origin = context
  watch = observer
  active = true
  mapEach(registered, (exports, name) =>
    arrayEach(entries(exports), item => harden(item[1], `${name}:${item[0]}`)),
  )
}

/** 配置是纯数据；固定快照，避免通过全局上下文改写监控策略。 */
export function freezeData<T>(value: T): T {
  const seen = newWeakSet<object>()
  const visit = (item: unknown): void => {
    if (!item || typeof item !== "object" || weakSetHas(seen, item)) return
    weakSetAdd(seen, item)
    arrayEach(values(descriptors(item)), descriptor => {
      if ("value" in descriptor) visit(descriptor.value)
    })
    objectFreeze(item)
  }
  visit(value)
  return value
}

registerModule("protect/intrinsics.ts", intrinsics)
registerModule("protect/objects.ts", { refuse, seal, registerModule, protectObjects, freezeData })
