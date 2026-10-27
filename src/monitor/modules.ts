import path from "node:path"
import { fileURLToPath } from "node:url"
import { types } from "node:util"
import { randomUUID, createHash } from "node:crypto"
import { setInterval, clearInterval } from "node:timers"
import { decodeModuleSource } from "./source.js"
import { isReference, sameDescriptor } from "../protect/intrinsics.js"
import { within } from "../protect/paths.js"
import { ownFunctionExports } from "./exports.js"
import type { EmitEvent } from "../shared/types.js"
import type { HookWatch } from "./watch.js"

/** 观察配额只限制保留的登记和报告，不限制恶意 JS 的执行。 */
export const MODULE_AUDIT_LIMITS = Object.freeze({
  installations: 32,
  modules: 2048,
  graphNodes: 8192,
  resolutionEdges: 32_768,
  properties: 256,
  moduleSlots: 512,
  inspectionsPerModule: 4096,
  slots: 16_384,
  reportsPerCheck: 128,
  coverageReports: 32,
  sourceBytes: 4 * 1024 * 1024,
})

export interface ModuleAuditOptions {
  root: string
  guardRoot: string
  emit: EmitEvent
  contextPlugin?: () => string | undefined
  originalFunction?: (value: Function) => Function
  intervalMs?: number
  watch?: HookWatch
}

export interface ModuleAudit {
  instrument(url: string, format: string | undefined, source: unknown): string | undefined
  resolve(parentURL: string | undefined, resolvedURL: string): void
  check(plugin?: string): void
  close(): void
}

interface Slot {
  owner: object
  descriptor: PropertyDescriptor
  exportedName: string
  keys: string[]
}

interface ModuleRecord {
  url: string
  target: string
  plugin: string
  tail: string
  namespace?: object
  baseline: boolean
  ownBaseline: boolean
  ownExports: Set<string>
  slots: Map<string, Slot>
  uninitialized: Set<string>
  watched: Map<object, () => void>
}

const ownNames = Object.getOwnPropertyNames
const ownDescriptor = Object.getOwnPropertyDescriptor
const proxy = types.isProxy
const bytes = Buffer.byteLength
const schedule = setInterval
const cancel = clearInterval
const observerURL = import.meta.url
const hash = createHash
const observers = new Map<string, (url: string, namespace: unknown) => void>()

/** 校验插件名是否可作为归因。 */
function attribution(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= 128 &&
    value !== "." &&
    value !== ".." &&
    /^[\p{L}\p{N}_.@ -]+$/u.test(value)
    ? value
    : undefined
}

/** 把属性名规范为安全标识，必要时取哈希。 */
function name(value: string): string {
  return /^[A-Za-z_$][\w$]{0,79}$/.test(value)
    ? value
    : `property-${hash("sha256").update(value).digest("hex")}`
}

/** 比较两个属性槽的所有者与描述符。 */
function equal(before: Slot, after: Slot): boolean {
  return before.owner === after.owner && sameDescriptor(before.descriptor, after.descriptor)
}

/** 由追加的 ESM 代码调用；观察失败不能影响业务模块求值。 */
export function observeModule(id: string, url: string, namespace: unknown): void {
  try {
    observers.get(id)?.(url, namespace)
  } catch {
    // 仅在同一受信进程内尽力观察，不构成隔离边界。
  }
}

/**
 * 观察导出函数及其自有静态或原型函数描述符。
 * 不包装、冻结、恢复或阻止插件修改；不处理 CJS 及对象图。
 */
export function installModuleAudit(options: ModuleAuditOptions): ModuleAudit {
  const root = path.resolve(options.root)
  const guardRoot = path.resolve(options.guardRoot)
  const modules = new Map<string, ModuleRecord>()
  const functionOrigins = new WeakMap<object, string>()
  const uncertainOrigins = new WeakSet<object>()
  const outgoing = new Map<string, Set<string>>()
  const incoming = new Map<string, Set<string>>()
  let graphRevision = 0
  let componentRevision = -1
  let components = new Map<string, ReadonlySet<string>>()
  const reportedCoverage = new Set<string>()
  const id = randomUUID()
  let totalSlots = 0
  let sequence = 0
  let closed = false
  let checking = false
  let edgeCount = 0
  let graphDegraded = false
  let timer: ReturnType<typeof setInterval> | undefined

  /** 上报事件，异常不影响模块求值。 */
  function emit(event: Parameters<EmitEvent>[0]): void {
    try {
      options.emit(event)
    } catch {
      // 默认观察模式下，遥测错误不能成为业务错误。
    }
  }

  /** 按原因去重上报覆盖不足，保留各类故障的报告名额。 */
  function coverage(reason: string, record?: Pick<ModuleRecord, "target" | "plugin">): void {
    // 为每种不同故障保留报告空间，防止大量循环模块耗尽预算，
    // 静默掩盖后续模块、依赖图或源码限额故障。
    const key = reason
    if (reportedCoverage.has(key) || reportedCoverage.size >= MODULE_AUDIT_LIMITS.coverageReports)
      return
    reportedCoverage.add(key)
    emit({
      kind: "coverage",
      operation: "module-audit-unavailable",
      target: record?.target ?? "plugin-modules",
      ...(record ? { plugin: record.plugin } : {}),
      action: "audit",
      details: { reason, coverage: "partial" },
    })
  }

  /** 列出对象的可观察属性名，Proxy 返回空。 */
  function properties(object: object, record: ModuleRecord): string[] {
    if (proxy(object)) {
      coverage("proxy", record)
      return []
    }
    const names = ownNames(object)
    if (names.length > MODULE_AUDIT_LIMITS.properties) coverage("property-limit", record)
    // 反射枚举本身仍会分配 Node 的自有键列表；配额只限制保留量。
    return names.slice(0, MODULE_AUDIT_LIMITS.properties)
  }

  /** 把描述符中的已包装函数还原为原函数后比较。 */
  function canonical(descriptor: PropertyDescriptor, record: ModuleRecord): PropertyDescriptor {
    if (
      !options.originalFunction ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function" ||
      proxy(descriptor.value)
    )
      return descriptor
    try {
      const original = options.originalFunction(descriptor.value)
      if (typeof original !== "function" || proxy(original)) {
        coverage("normalization-failed", record)
        return descriptor
      }
      return original === descriptor.value ? descriptor : { ...descriptor, value: original }
    } catch {
      coverage("normalization-failed", record)
      return descriptor
    }
  }

  /** 检查一个模块记录中的全部属性槽，返回变化列表。 */
  function inspect(
    record: ModuleRecord,
    registerOrigins = false,
    ownOnly = !record.baseline,
  ): Map<string, Slot> {
    const result = new Map<string, Slot>()
    const namespace = record.namespace!
    const budget = Math.min(
      MODULE_AUDIT_LIMITS.moduleSlots,
      MODULE_AUDIT_LIMITS.slots - totalSlots + record.slots.size,
    )
    const previouslyUninitialized = record.uninitialized
    const uninitialized = new Set<string>()
    let inspected = 0
    // 优先保留现有目标，再为新发现的函数分配容量。
    // 每次从当前命名空间解析；仅检查旧持有对象无法发现
    // 导出的构造器或其原型已被替换。
    for (const [target, previous] of record.slots) {
      let owner: object | undefined = namespace
      let uncertain = false
      try {
        for (const key of previous.keys.slice(0, -1)) {
          if (proxy(owner)) {
            uncertain = true
            break
          }
          const descriptor = ownDescriptor(owner, key)
          if (!descriptor || !("value" in descriptor) || !isReference(descriptor.value)) {
            owner = undefined
            break
          }
          owner = descriptor.value
        }
        if (owner && proxy(owner)) uncertain = true
        if (uncertain) {
          coverage("proxy", record)
          result.set(target, previous)
        } else if (owner) {
          const descriptor = ownDescriptor(owner, previous.keys.at(-1)!)
          if (descriptor)
            result.set(target, { ...previous, owner, descriptor: canonical(descriptor, record) })
        }
      } catch {
        coverage("inspection-failed", record)
        result.set(target, previous)
      }
    }
    if (budget === 0 && !registerOrigins) {
      coverage("slot-limit", record)
      return result
    }
    /** 记录函数来源模块，用于归因。 */
    function captureOrigin(value: object, enabled: boolean): void {
      if (!enabled || proxy(value)) return
      if (!uncertainOrigins.has(value) && !functionOrigins.has(value))
        functionOrigins.set(value, record.plugin)
    }
    /** 检查本模块的检查次数是否仍在限额内。 */
    function available(): boolean {
      if (++inspected > MODULE_AUDIT_LIMITS.inspectionsPerModule) {
        coverage("inspection-limit", record)
        return false
      }
      return true
    }
    /** 登记一个函数及其属性槽基线。 */
    function add(
      object: object,
      key: string,
      parts: string[],
      keys: string[],
    ): PropertyDescriptor | undefined {
      const raw = ownDescriptor(object, key)
      const descriptor = raw && canonical(raw, record)
      if (!descriptor) return undefined
      const target = `${record.target}#${parts.join(".")}`
      if (result.has(target)) return descriptor
      if (result.size >= budget) {
        coverage("slot-limit", record)
        return descriptor
      }
      result.set(target, { owner: object, descriptor, exportedName: parts[0]!, keys })
      return descriptor
    }
    /** 登记类的静态方法与原型方法。 */
    function methods(object: object, prefix: string[], keys: string[], origins: boolean): void {
      if (proxy(object)) {
        coverage("proxy", record)
        return
      }
      for (const key of properties(object, record)) {
        if (!available()) break
        const descriptor = ownDescriptor(object, key)
        if (descriptor && "value" in descriptor && typeof descriptor.value === "function") {
          add(object, key, [...prefix, name(key)], [...keys, key])
          const value = canonical(descriptor, record).value as object
          captureOrigin(value, origins)
        }
      }
    }
    if (proxy(namespace)) {
      coverage("proxy", record)
      return result
    }
    for (const key of properties(namespace, record)) {
      if (ownOnly && !record.ownExports.has(key)) continue
      if (!available()) break
      const exportedName = name(key)
      let descriptor: PropertyDescriptor | undefined
      try {
        descriptor = ownDescriptor(namespace, key)
      } catch {
        // 其他模块完成时，循环重导出仍可能处于暂时性死区。
        coverage("uninitialized-export", record)
        uninitialized.add(exportedName)
        continue
      }
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function")
        continue
      const origins = registerOrigins || previouslyUninitialized.has(exportedName)
      add(namespace, key, [exportedName], [key])
      const fn = descriptor.value as object
      if (proxy(fn)) {
        coverage("proxy", record)
        continue
      }
      captureOrigin(fn, origins)
      methods(fn, [exportedName], [key], origins)
      const prototype = ownDescriptor(fn, "prototype")
      if (prototype && "value" in prototype && isReference(prototype.value)) {
        add(fn, "prototype", [exportedName, "prototype"], [key, "prototype"])
        methods(prototype.value, [exportedName, "prototype"], [key, "prototype"], origins)
      }
    }
    record.uninitialized = uninitialized
    return result
  }

  /** 返回当前插件归因：显式值优先，其次异步上下文。 */
  function currentPlugin(explicit?: string): string | undefined {
    if (attribution(explicit)) return explicit
    try {
      return attribution(options.contextPlugin?.())
    } catch {
      return undefined
    }
  }

  /** 为模块导出对象登记反射入口观察。 */
  function observe(record: ModuleRecord): void {
    if (!options.watch) return
    const owners = new Map<object, { prefix: string; keys: string[] }>()
    for (const [target, slot] of record.slots) {
      owners.set(slot.owner, {
        prefix: `${record.target}#${slot.keys.slice(0, -1).map(name).join(".")}`,
        keys: slot.keys.slice(0, -1),
      })
      const value = slot.descriptor.value as unknown
      if (
        isReference(value) &&
        !proxy(value) &&
        (typeof value === "function" || slot.keys.at(-1) === "prototype")
      )
        if (!owners.has(value)) owners.set(value, { prefix: target, keys: slot.keys })
    }
    for (const [object, stop] of record.watched)
      if (!owners.has(object)) {
        stop()
        record.watched.delete(object)
      }
    for (const [object, { prefix, keys }] of owners) {
      if (record.watched.has(object)) continue
      record.watched.set(
        object,
        options.watch.track(object, {
          /** 反射入口修改后检查对应模块。 */
          after(change) {
            if (closed || checking) return
            if (change.key === undefined && change.changed === false) return
            const key =
              change.key === undefined
                ? undefined
                : typeof change.key === "symbol"
                  ? `symbol-${hash("sha256").update(String(change.key)).digest("hex")}`
                  : name(String(change.key))
            const plugin = currentPlugin()
            const functionChange =
              change.changed === true &&
              (change.prototypeChanged ||
                change.properties?.some(
                  ({ key, before, after }) =>
                    [...record.slots.values()].some(
                      slot => slot.owner === object && slot.keys.at(-1) === key,
                    ) ||
                    [before, after].some(
                      property =>
                        property &&
                        (typeof property.value === "function" ||
                          typeof property.get === "function" ||
                          typeof property.set === "function" ||
                          (key === "prototype" && isReference(property.value))),
                    ),
                ))
            emit({
              kind: "integrity",
              operation: functionChange ? "module-function-change" : "module-function-hook",
              target:
                key === undefined ? prefix : `${prefix}${prefix.endsWith("#") ? "" : "."}${key}`,
              plugin: plugin ?? "unknown",
              action: "audit",
              timestamp: new Date().toISOString(),
              details: {
                method: change.operation,
                outcome: change.outcome,
                changed: change.changed ?? "unknown",
                blocked: change.outcome === "blocked",
                detection: "during-call",
                attribution: plugin ? "current-plugin" : "unknown",
              },
            })
            // 已即时报告的槽同步更新，轮询仍负责普通赋值和新路径。
            for (const [target, slot] of record.slots) {
              if (
                slot.owner !== object ||
                (change.key !== undefined && slot.keys.at(-1) !== change.key)
              )
                continue
              const next = ownDescriptor(object, slot.keys.at(-1)!)
              if (next) slot.descriptor = canonical(next, record)
              else {
                record.slots.delete(target)
                totalSlots--
              }
            }
            const candidates =
              change.key === undefined
                ? properties(object, record)
                : typeof change.key === "string"
                  ? [change.key]
                  : []
            for (const key of candidates) {
              const next = ownDescriptor(object, key)
              if (
                !next ||
                !("value" in next) ||
                (typeof next.value !== "function" &&
                  !(key === "prototype" && isReference(next.value)))
              )
                continue
              const target = `${prefix}${prefix.endsWith("#") ? "" : "."}${name(key)}`
              if (record.slots.has(target)) continue
              if (
                record.slots.size >= MODULE_AUDIT_LIMITS.moduleSlots ||
                totalSlots >= MODULE_AUDIT_LIMITS.slots
              ) {
                coverage("slot-limit", record)
                break
              }
              record.slots.set(target, {
                owner: object,
                descriptor: canonical(next, record),
                exportedName: name(keys[0] ?? key),
                keys: [...keys, key],
              })
              totalSlots++
            }
            observe(record)
          },
        }),
      )
    }
  }

  /** 检查模块函数变化并上报。 */
  function check(plugin?: string): void {
    if (closed || checking) return
    checking = true
    let reports = 0
    const context = currentPlugin(plugin)
    try {
      for (const record of modules.values()) {
        if (!record.namespace || (!record.baseline && !record.ownBaseline)) continue
        let after: Map<string, Slot>
        const uninitialized = record.uninitialized
        try {
          after = inspect(record)
        } catch {
          coverage("inspection-failed", record)
          continue
        }
        for (const target of new Set([...record.slots.keys(), ...after.keys()])) {
          const before = record.slots.get(target)
          const next = after.get(target)
          if (!before && next && uninitialized.has(next.exportedName)) continue
          if (before && next && equal(before, next)) continue
          if (reports >= MODULE_AUDIT_LIMITS.reportsPerCheck) {
            coverage("report-limit", record)
            break
          }
          reports++
          const replacement = next?.descriptor.value as unknown
          const origin =
            isReference(replacement) && !proxy(replacement)
              ? functionOrigins.get(replacement)
              : undefined
          emit({
            kind: "integrity",
            operation: "module-function-change",
            target,
            plugin: origin ?? context ?? "unknown",
            action: "audit",
            timestamp: new Date().toISOString(),
            details: {
              reason: !before ? "added" : !next ? "removed" : "descriptor",
              blocked: false,
              detection: "after-change",
              attribution: origin ? "observed-function" : context ? "current-plugin" : "unknown",
            },
          })
        }
        totalSlots += after.size - record.slots.size
        record.slots = after
        observe(record)
      }
    } catch {
      coverage("inspection-failed")
    } finally {
      checking = false
    }
  }

  /** 从模块 URL 推断插件名与目标标识。 */
  function location(url: string): { target: string; plugin: string; filename: string } | undefined {
    if (url.length > 8192) return undefined
    const parsed = new URL(url)
    if (parsed.protocol !== "file:") return undefined
    const filename = fileURLToPath(parsed)
    const relative = path.relative(root, filename)
    const parts = relative.split(path.sep)
    if (
      parts[0] !== "plugins" ||
      parts.length < 3 ||
      parts.includes("node_modules") ||
      within(guardRoot, filename)
    )
      return undefined
    if (!attribution(parts[1]) || relative.length > 1024) {
      coverage("unsupported-path")
      return undefined
    }
    return {
      target: parts.map(part => encodeURIComponent(part)).join("/"),
      plugin: parts[1]!,
      filename,
    }
  }

  /** 记录模块依赖边，用于循环依赖中的身份判断。 */
  function resolve(parentURL: string | undefined, resolvedURL: string): void {
    if (closed || graphDegraded || !parentURL || parentURL === resolvedURL) return
    try {
      // 不透明的核心或包桥接参与环检测，但不插入监控代码。
      for (const url of [parentURL, resolvedURL]) {
        if (url === observerURL || url.length > 8192) return
        const parsed = new URL(url)
        if (parsed.protocol !== "file:") return
        const filename = fileURLToPath(parsed)
        if (
          within(guardRoot, filename) ||
          ![".js", ".mjs", ".cjs"].includes(path.extname(filename))
        )
          return
      }
      for (const url of [parentURL, resolvedURL]) {
        if (outgoing.has(url)) continue
        if (outgoing.size >= MODULE_AUDIT_LIMITS.graphNodes) {
          graphDegraded = true
          coverage("resolution-limit")
          return
        }
        outgoing.set(url, new Set())
        incoming.set(url, new Set())
        graphRevision++
      }
      if (outgoing.get(parentURL)!.has(resolvedURL)) return
      if (edgeCount >= MODULE_AUDIT_LIMITS.resolutionEdges) {
        graphDegraded = true
        coverage("resolution-limit")
        return
      }
      outgoing.get(parentURL)!.add(resolvedURL)
      incoming.get(resolvedURL)!.add(parentURL)
      edgeCount++
      graphRevision++
    } catch {
      graphDegraded = true
      coverage("resolution-unavailable")
    }
  }

  /** 返回模块所在的强连通分量。 */
  function component(url: string): string[] {
    if (componentRevision !== graphRevision) {
      const seen = new Set<string>()
      const finished: string[] = []
      // 使用迭代式 Kosaraju，避免配额上限内的长依赖链耗尽 JS 调用栈。
      for (const start of outgoing.keys()) {
        if (seen.has(start)) continue
        seen.add(start)
        const pending = [{ url: start, edges: outgoing.get(start)!.values() }]
        while (pending.length) {
          const current = pending[pending.length - 1]!
          const next = current.edges.next()
          if (next.done) {
            finished.push(current.url)
            pending.pop()
          } else if (!seen.has(next.value)) {
            seen.add(next.value)
            pending.push({ url: next.value, edges: outgoing.get(next.value)!.values() })
          }
        }
      }
      seen.clear()
      const nextComponents = new Map<string, ReadonlySet<string>>()
      for (let index = finished.length - 1; index >= 0; index--) {
        const start = finished[index]!
        if (seen.has(start)) continue
        const members = new Set<string>()
        const pending = [start]
        seen.add(start)
        while (pending.length) {
          const current = pending.pop()!
          members.add(current)
          for (const previous of incoming.get(current)!)
            if (!seen.has(previous)) {
              seen.add(previous)
              pending.push(previous)
            }
        }
        for (const member of members) nextComponents.set(member, members)
      }
      components = nextComponents
      componentRevision = graphRevision
    }
    const members = components.get(url)
    if (!members || members.size === 1) return [url]
    // 保留原有正向 DFS 晋升顺序，首先处理刚完成的模块。
    const seen = new Set<string>()
    const pending = [url]
    while (pending.length) {
      const current = pending.pop()!
      if (seen.has(current)) continue
      seen.add(current)
      for (const next of outgoing.get(current) ?? [])
        if (members.has(next) && !seen.has(next)) pending.push(next)
    }
    return [...seen]
  }

  /** 模块求值完成后建立导出函数基线。 */
  function complete(url: string, namespace: unknown): void {
    const record = modules.get(url)
    if (closed || !record || !isReference(namespace) || proxy(namespace)) return
    if (record.namespace) return
    record.namespace = namespace
    try {
      record.slots = inspect(record, true, true)
      totalSlots += record.slots.size
      record.ownBaseline = true
      observe(record)
    } catch {
      coverage("inspection-failed", record)
    }
    // 模块完成时，其自有声明已就绪，环内重导出则未必；
    // 晋升前先检查，避免后续成员掩盖钩子篡改。
    check(record.plugin)
    if (graphDegraded) return
    const group = component(url)
    const cyclic = group.length > 1
    if (cyclic) coverage("cyclic-baseline-deferred", record)
    // 仅延后内部记录更新，不延迟成员模块求值或 import Promise。
    const observed = group
      .map(member => modules.get(member))
      .filter((item): item is ModuleRecord => !!item)
    if (observed.some(item => !item.namespace)) return
    for (const item of observed) {
      if (item.baseline) continue
      try {
        const previousSize = item.slots.size
        item.slots = inspect(item, !cyclic, false)
        if (cyclic)
          for (const slot of item.slots.values()) {
            if (
              typeof slot.descriptor.value === "function" &&
              !functionOrigins.has(slot.descriptor.value)
            )
              uncertainOrigins.add(slot.descriptor.value)
          }
        totalSlots += item.slots.size - previousSize
        item.baseline = true
        observe(item)
      } catch {
        coverage("inspection-failed", item)
      }
    }
    // 晋升仅检查描述符；晋升前的同步检查已在登记当前模块的替代函数后，
    // 检查过先前模块。
  }

  /** 在模块源码末尾追加观察调用。 */
  function instrument(
    url: string,
    format: string | undefined,
    source: unknown,
  ): string | undefined {
    if (closed) return undefined
    try {
      const label = location(url)
      if (!label) return undefined
      if (format !== "module" || ![".js", ".mjs"].includes(path.extname(label.filename))) {
        coverage("unsupported-format", label)
        return undefined
      }
      const text = decodeModuleSource(source)
      if (text === undefined) {
        coverage("source-unavailable", label)
        return undefined
      }
      if (bytes(text) > MODULE_AUDIT_LIMITS.sourceBytes) {
        coverage("source-limit", label)
        return undefined
      }
      let record = modules.get(url)
      if (!record) {
        if (modules.size >= MODULE_AUDIT_LIMITS.modules) {
          coverage("module-limit")
          return undefined
        }
        const suffix = `${id.replaceAll("-", "")}_${++sequence}`
        const namespace = `__yunzaiGuardNamespace_${suffix}`
        const observe = `__yunzaiGuardObserve_${suffix}`
        let ownExports = new Set<string>()
        try {
          ownExports = ownFunctionExports(text)
        } catch {
          coverage("export-ownership-unavailable", label)
        }
        record = {
          url,
          ...label,
          slots: new Map(),
          baseline: false,
          ownBaseline: false,
          ownExports,
          uninitialized: new Set(),
          watched: new Map(),
          tail: `\n;import * as ${namespace} from ${JSON.stringify(url)};\nimport { observeModule as ${observe} } from ${JSON.stringify(observerURL)};\n${observe}(${JSON.stringify(id)},${JSON.stringify(url)},${namespace});\n`,
        }
        modules.set(url, record)
      }
      return text + record.tail
    } catch {
      coverage("instrumentation-failed")
      return undefined
    }
  }

  if (observers.size >= MODULE_AUDIT_LIMITS.installations) {
    coverage("installation-limit")
    closed = true
  } else {
    observers.set(id, complete)
    const interval = Number.isFinite(options.intervalMs)
      ? Math.max(10, Math.min(60_000, options.intervalMs!))
      : 1000
    timer = schedule(() => check(), interval)
    timer.unref()
  }

  return {
    instrument,
    resolve,
    check,
    /** 停止观察并清理定时器。 */
    close() {
      closed = true
      if (timer) cancel(timer)
      timer = undefined
      observers.delete(id)
      for (const record of modules.values()) for (const stop of record.watched.values()) stop()
      modules.clear()
      outgoing.clear()
      incoming.clear()
      components.clear()
      totalSlots = 0
    },
  }
}
