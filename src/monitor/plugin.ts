import { evaluatePolicy, GuardDeniedError } from "../config/policy.js"
import type { EmitEvent, GuardContext } from "../shared/types.js"
import type { HookWatch } from "./watch.js"

type Dynamic = Record<string, unknown>
export interface PluginActivity {
  name: string
  imports: number
  loads: number
  registered: number
  calls: number
  blocked: number
  unwrapped: number
}
export interface PluginSnapshot {
  entries: PluginActivity[]
  truncated: boolean
}
const apply = Reflect.apply
const descriptor = Object.getOwnPropertyDescriptor
const define = Object.defineProperty
const names = Object.getOwnPropertyNames
const limit = 128
/** 饱和加一。 */
const increment = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, value + 1)

/** 兼容性插桩只记录入口次数及归属，不构成恶意代码防护边界。 */
export class PluginMonitor {
  readonly #context: GuardContext
  readonly #emit: EmitEvent
  readonly #check: () => void
  readonly #watch?: HookWatch
  readonly #currentPlugin?: () => string | undefined
  readonly #observed = new WeakSet<object>()
  readonly #entries = new Map<string, PluginActivity>()
  readonly #wrapped = new WeakMap<Function, { original: Function; name: string }>()
  readonly #instances = new WeakMap<object, string>()
  #truncated = false

  /** 创建插件入口监控。 */
  constructor(
    context: GuardContext,
    emit: EmitEvent,
    check: () => void,
    watch?: HookWatch,
    currentPlugin?: () => string | undefined,
  ) {
    this.#context = context
    this.#emit = emit
    this.#check = check
    this.#watch = watch
    this.#currentPlugin = currentPlugin
  }

  /** 为插件实例登记反射入口观察。 */
  #observe(object: object, name: string, target: string): void {
    if (!this.#watch || this.#observed.has(object)) return
    this.#observed.add(object)
    this.#watch.track(object, {
      after: change => {
        if (change.key === undefined && change.changed === false) return
        const plugin = this.#currentPlugin?.()
        const event = {
          kind: "integrity",
          operation: "plugin-function-hook",
          target: `plugins/${encodeURIComponent(name)}#${target}`,
          plugin: plugin ?? "unknown",
          details: {
            method: change.operation,
            outcome: change.outcome,
            changed: change.changed ?? "unknown",
            blocked: change.outcome === "blocked",
            detection: "during-call",
            attribution: plugin ? "current-plugin" : "unknown",
          },
        }
        this.#emit({ ...event, ...evaluatePolicy(this.#context.settings, event) })
      },
    })
  }

  /** 取得或创建插件活动统计条目。 */
  #entry(name: string): PluginActivity | undefined {
    const existing = this.#entries.get(name)
    if (existing) return existing
    if (this.#entries.size >= limit) {
      this.#truncated = true
      return undefined
    }
    const row = {
      name: name.slice(0, 128),
      imports: 0,
      loads: 0,
      registered: 0,
      calls: 0,
      blocked: 0,
      unwrapped: 0,
    }
    this.#entries.set(name, row)
    return row
  }

  /** 返回插件活动统计快照。 */
  snapshot(): PluginSnapshot {
    return {
      entries: [...this.#entries.values()].map(row => ({ ...row })),
      truncated: this.#truncated,
    }
  }

  /** 让观察器比较受信插桩与其包装的原函数。 */
  originalFunction(value: Function): Function {
    return this.#wrapped.get(value)?.original ?? value
  }

  /** 登记核心创建的插件实例并包装其方法。 */
  attachInstance(instance: Dynamic, name: string): void {
    this.#instances.set(instance, name)
    for (const key of names(instance)) this.#wrap(instance, key, name)
    this.#observe(instance, name, "instance")
  }

  /** Yunzai 为每条消息新建处理器实例，须保留原 new.target。 */
  construct(constructor: Function, args: unknown[], name: string): object {
    return this.#invoke(name, "plugin.construct", constructor.name, () => {
      const instance = Reflect.construct(constructor, args) as Dynamic
      this.attachInstance(instance, name)
      return instance
    })
  }

  /** 在插件上下文中执行入口，先按规则检查。 */
  #invoke<T>(name: string, operation: string, target: string, callback: () => T): T {
    const row = this.#entry(name)
    if (row) {
      const counter =
        operation === "plugin.import" ? "imports" : operation === "plugin.load" ? "loads" : "calls"
      row[counter] = increment(row[counter])
    }
    const event = {
      kind: "plugin",
      plugin: name,
      operation,
      target,
      timestamp: new Date().toISOString(),
    }
    const decision = evaluatePolicy(this.#context.settings, event)
    if (decision.action !== "audit" && row) row.blocked = increment(row.blocked)
    this.#emit({ ...event, ...decision, details: { blocked: decision.action !== "audit" } })
    if (decision.action !== "audit") throw new GuardDeniedError(operation, decision.ruleId)
    this.#check()
    try {
      // 原样返回结果或 Promise；添加拒绝观察器会改变未处理拒绝的行为。
      return this.#context.run(name, callback)
    } finally {
      this.#check()
    }
  }

  /** 包装对象上的一个方法，保留原有 this 与返回值。 */
  #wrap(object: object, key: string, name: string, operation = "plugin.call"): void {
    const property = descriptor(object, key)
    if (typeof property?.value !== "function") return
    const previous = this.#wrapped.get(property.value)
    if (previous?.name === name) return
    const original = previous?.original ?? (property.value as Function)
    const monitor = this
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const owner =
        this && (typeof this === "object" || typeof this === "function")
          ? (monitor.#instances.get(this as object) ?? name)
          : name
      return monitor.#invoke(owner, operation, key, () => apply(original, this, args))
    }
    try {
      define(object, key, { ...property, value: wrapped })
      this.#wrapped.set(wrapped, { original, name })
      this.#observe(original, name, key)
      this.#observe(wrapped, name, key)
    } catch {
      const row = this.#entry(name)
      if (row) row.unwrapped = increment(row.unwrapped)
    }
  }

  /** 仅桥接加载器实例，不修改构造器或磁盘核心源码。 */
  attach(loader: Dynamic): void {
    const monitor = this
    const importPlugin = loader.importPlugin as Function
    loader.importPlugin = function (this: Dynamic, file: { name: string }, ...args: unknown[]) {
      return monitor.#invoke(file.name, "plugin.import", "module", () =>
        apply(importPlugin, this, [file, ...args]),
      )
    }
    const loadPlugin = loader.loadPlugin as Function
    loader.loadPlugin = function (this: Dynamic, file: { name: string }, constructor: Function) {
      const prototype = constructor?.prototype as Dynamic | undefined
      if (prototype)
        for (const key of names(prototype))
          if (key !== "constructor") monitor.#wrap(prototype, key, file.name)
      if (prototype) monitor.#observe(prototype, file.name, "prototype")
      if (typeof constructor === "function") monitor.#observe(constructor, file.name, "constructor")
      return monitor.#invoke(file.name, "plugin.load", constructor?.name ?? "unknown", () =>
        apply(loadPlugin, this, [file, constructor]),
      )
    }
    const registerHandlers = loader.registerHandlers as Function
    loader.registerHandlers = function (this: Dynamic, instance: Dynamic, ...args: unknown[]) {
      const entries = this.priority as Array<{ plugin: object; key: string }> | undefined
      const name =
        monitor.#instances.get(instance) ?? entries?.find(row => row.plugin === instance)?.key
      if (name) {
        if (!monitor.#instances.has(instance)) {
          const row = monitor.#entry(name)
          if (row) row.registered = increment(row.registered)
        }
        monitor.attachInstance(instance, name)
      }
      return apply(registerHandlers, this, [instance, ...args])
    }
    const collectTask = loader.collectTask as Function
    loader.collectTask = function (this: unknown, task: unknown, name: unknown, key: string) {
      for (const item of Array.isArray(task) ? task : [task])
        if (item && typeof item === "object") {
          monitor.#wrap(item, "fnc", key, "plugin.task")
          monitor.#observe(item, key, "task")
        }
      return apply(collectTask, this, [task, name, key])
    }
  }
}
