import fs from "node:fs"
import path from "node:path"
import { AsyncLocalStorage } from "node:async_hooks"
import type { GuardSettings, EmitEvent } from "../shared/types.js"
import type { NativeClassDescriptor } from "./types.js"
import { NativePluginClient, snapshotEvent } from "./client.js"
import { randomUUID } from "node:crypto"
import { validateNativeDescriptor } from "./validation.js"
import { NativeRegistrationBudget } from "./registrations.js"
import { parseNativePriority } from "./priority.js"
import { M } from "../shared/messages.js"
import { LoaderHooks } from "../monitor/loader-hooks.js"
import { detectCoreProfile } from "../monitor/loader.js"

type Row = Record<string, any>
interface MessageInstance {
  client: NativePluginClient
  classId: string
  instanceId: string
}
interface RuleCall {
  client: NativePluginClient
  classId: string
  ruleIndex: number
}
const metadataKeys = new Set([
  "name",
  "dsc",
  "event",
  "priority",
  "rule",
  "task",
  "handler",
  "namespace",
])
const forbiddenMethods = new Set(["constructor", "__proto__", "prototype", "then"])
/** 校验为普通对象。 */
function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(M.nativeSandbox.pluginMetadata)
  return value
}

/** 在原加载器导入选中插件源码前，先确定原生进程执行路径。 */
export class NativePluginLoader {
  private readonly clients = new Map<string, NativePluginClient>()
  private readonly loadedFiles = new Map<string, Set<string>>()
  private readonly failedPlugins = new Set<string>()
  private readonly matchers = new WeakMap<RegExp, (text: string) => Promise<boolean>>()
  private readonly ruleCalls = new WeakMap<object, RuleCall>()
  private readonly ruleMarkers = new WeakMap<RegExp, RuleCall>()
  private readonly messageScope = new AsyncLocalStorage<Map<object, MessageInstance>>()
  private readonly closedScopes = new WeakSet<Map<object, MessageInstance>>()
  private readonly registrations = new NativeRegistrationBudget()
  private loader?: Row
  private originalUnload?: Function
  /** 创建原生插件加载器。 */
  constructor(
    private readonly root: string,
    private readonly settings: GuardSettings,
    private readonly emit: EmitEvent,
    private readonly restart?: () => void,
  ) {}

  /** 返回插件的沙箱配置。 */
  private configuration(name: string) {
    const directory = name.split("/")[0]
    return this.settings.pluginSandbox.native.plugins.find(
      config => config.enabled && config.id === directory,
    )
  }

  /** 取得或创建插件的沙箱客户端。 */
  private client(name: string): NativePluginClient {
    const config = this.configuration(name)
    if (!config) throw new Error(M.nativeSandbox.notConfigured)
    if (this.failedPlugins.has(config.id)) throw new Error(M.nativeSandbox.disabledAfterFailure)
    let client = this.clients.get(config.id)
    if (!client) {
      client = new NativePluginClient(
        this.root,
        config,
        this.settings,
        this.emit,
        () => Reflect.get(globalThis, "redis"),
        () => this.retire(config.id),
        this.restart,
      )
      this.clients.set(config.id, client)
    }
    return client
  }

  /** 退役插件的沙箱会话。 */
  private async retire(id: string): Promise<void> {
    this.failedPlugins.add(id)
    const affected = new Set(this.loadedFiles.get(id) ?? [])
    for (const item of (this.loader?.priority ?? []) as Row[])
      if (this.configuration(item.key)?.id === id) affected.add(item.key)
    const results = await Promise.allSettled(
      [...affected].map(key => Reflect.apply(this.originalUnload!, this.loader, [key])),
    )
    if (results.some(result => result.status === "rejected"))
      throw new Error(M.nativeSandbox.retireFailed)
    this.loadedFiles.delete(id)
    this.registrations.release(id)
  }

  /** 在沙箱中测试规则。 */
  async testRule(regexp: RegExp, text: string): Promise<boolean> {
    const match = this.matchers.get(regexp)
    return match ? match(text) : regexp.test(text)
  }

  /** 生成规则方法的调用参数。 */
  ruleArgs(fn: Function | undefined, regexp: RegExp, event: Row): unknown[] {
    const rule = this.ruleMarkers.get(regexp)
    if (rule) {
      const marker = Object.freeze({})
      this.ruleCalls.set(marker, rule)
      return [event, marker]
    }
    return (fn?.length ?? 0) >= 2 ? [event, regexp.exec(String(event.msg)) || undefined] : [event]
  }

  /** 释放消息处理期间创建的实例。 */
  private async releaseInstances(scope: Map<object, MessageInstance>): Promise<void> {
    this.closedScopes.add(scope)
    const groups = new Map<NativePluginClient, MessageInstance[]>()
    for (const item of scope.values()) {
      const entries = groups.get(item.client) ?? []
      entries.push(item)
      groups.set(item.client, entries)
    }
    const released = await Promise.allSettled(
      [...groups].map(async ([client, entries]) => {
        for (let index = 0; index < entries.length; index += 16)
          await client.releaseInstances(
            entries.slice(index, index + 16).map(({ classId, instanceId }) => ({
              classId,
              instanceId,
            })),
          )
      }),
    )
    scope.clear()
    if (released.some(item => item.status === "rejected")) {
      await Promise.allSettled([...groups.keys()].map(client => client.close()))
      for (const client of groups.keys())
        this.emit({
          kind: "plugin-sandbox",
          plugin: client.config.id,
          operation: "native.cleanup-unconfirmed",
          target: client.config.id,
          action: "restart",
          details: { reason: "message-instance-release" },
        })
      throw new Error(M.nativeSandbox.instanceCleanup)
    }
  }

  /** 为沙箱插件类生成核心可用的构造器代理。 */
  private constructorProxy(
    client: NativePluginClient,
    descriptor: NativeClassDescriptor,
    file: string,
  ): Function {
    validateNativeDescriptor(descriptor)
    if (
      !descriptor ||
      typeof descriptor.id !== "string" ||
      descriptor.id.length > 512 ||
      !Array.isArray(descriptor.methods) ||
      descriptor.methods.length > 257
    )
      throw new Error(M.nativeSandbox.classDescriptor)
    for (const method of descriptor.methods)
      if (typeof method !== "string" || method.length > 128 || forbiddenMethods.has(method))
        throw new Error(M.nativeSandbox.method)
    let metadata = row(descriptor.metadata)
    const base = Reflect.get(globalThis, "plugin") as new (settings: Row) => Row
    if (typeof base !== "function") throw new Error(M.nativeSandbox.pluginBase)
    const owner = this
    const instances = new Set<Row>()
    const namespace = `guard-native-${randomUUID()}`
    let initialized = false

    const invoke = async (
      instance: Row,
      method: string,
      args?: unknown[],
      handle?: string,
      handler = false,
      scheduled = false,
    ) => {
      if (scheduled) client.consumeTask()
      const initializing = method === "init" && !initialized && !handle && !instance.e
      if (initializing) initialized = true
      const event =
        handler && args?.[0] && typeof args[0] === "object" ? (args[0] as Row) : instance.e
      const hasEvent = !!args?.length && args[0] === event
      const values = args ? (hasEvent ? args.slice(1) : [...args]) : undefined
      const rule =
        hasEvent && values?.length === 1 && values[0] && typeof values[0] === "object"
          ? owner.ruleCalls.get(values[0])
          : undefined
      if (rule && (rule.client !== client || rule.classId !== descriptor.id))
        throw new Error(M.nativeSandbox.ruleMethod)
      const scope = owner.messageScope.getStore()
      let instanceId: string | undefined
      if (
        scope &&
        !owner.closedScopes.has(scope) &&
        event &&
        method !== "init" &&
        method !== "onUnload"
      ) {
        const existing = scope.get(instance)
        if (existing && (existing.client !== client || existing.classId !== descriptor.id))
          throw new Error(M.nativeSandbox.classDescriptor)
        instanceId = existing?.instanceId
        if (!instanceId) {
          if (scope.size >= 4096) throw new Error(M.nativeSandbox.messageInstances)
          instanceId = randomUUID()
          scope.set(instance, { client, classId: descriptor.id, instanceId })
        }
      }
      const context =
        !handler &&
        !hasEvent &&
        args?.length === 1 &&
        args[0] &&
        typeof args[0] === "object" &&
        (args[0] as Row).$type === "NativeContext"
          ? row(args[0])
          : undefined
      const reject =
        handler && typeof values?.at(-1) === "function"
          ? (values.pop() as (message: string) => unknown)
          : undefined
      const result = row(
        await client.request(
          handle ? "native-callback" : "native-call",
          {
            classId: descriptor.id,
            ...(instanceId ? { instanceId } : {}),
            ...(rule ? { ruleIndex: rule.ruleIndex } : {}),
            ...(handle ? { handle } : { method }),
            // 核心将当前事件作为首个参数，broker 仅提供值快照
            // 及该事件专属的回复能力，不序列化活动宿主事件。
            ...(context
              ? { contextHandle: context.id }
              : !rule && values && (hasEvent ? { eventArgs: values } : { args: values })),
            ...(reject ? { handlerReject: true } : {}),
          },
          event,
          reject ? { handlerReject: reject } : undefined,
        ),
      )
      if (result.metadata) {
        const updated = validateNativeDescriptor({
          ...descriptor,
          metadata: result.metadata,
          ...(initializing && result.methods !== undefined ? { methods: result.methods } : {}),
        })
        // 仅 init 可修改核心即将安装的资源；后续消息
        // 修改私有元数据时，不能扣减仍在运行的宿主任务账本。
        if (initializing) {
          this.registrations.update(client.config.id, file, updated)
          descriptor = updated
          installMethods(descriptor.methods)
        }
        metadata = updated.metadata
        if (initializing) for (const current of instances) assign(current)
      }
      return result.result
    }

    const decode = (value: unknown, instance: Row, depth = 0, scheduled = false): unknown => {
      if (depth > 16) throw new Error(M.nativeSandbox.nestingLimit)
      if (!value || typeof value !== "object") return value
      if (Array.isArray(value))
        return value.map(item => decode(item, instance, depth + 1, scheduled))
      const object = row(value)
      if (object.$type === "NativePriority") return parseNativePriority(object)
      if (object.$type === "NativeFunction") {
        if (typeof object.id !== "string" || object.id.length > 128)
          throw new Error(M.nativeSandbox.callbackHandle)
        return (...args: unknown[]) =>
          invoke(instance, "callback", args, object.id, false, scheduled)
      }
      if (object.$type === "RegExp") throw new Error(M.nativeSandbox.regexpProcess)
      const result = Object.create(null) as Row
      for (const [key, item] of Object.entries(object)) {
        if (["__proto__", "constructor", "prototype"].includes(key))
          throw new Error(M.nativeSandbox.unsafeKey)
        result[key] = decode(item, instance, depth + 1, scheduled)
      }
      return result
    }

    const assign = (instance: Row) => {
      for (const key of Object.keys(metadata))
        if (!metadataKeys.has(key)) throw new Error(M.nativeSandbox.metadataUnsupported(key))
      for (const key of ["name", "dsc", "event", "namespace"])
        if (
          metadata[key] !== undefined &&
          metadata[key] !== null &&
          (typeof metadata[key] !== "string" || metadata[key].length > 2048)
        )
          throw new Error(M.nativeSandbox.fieldInvalid(key))
      parseNativePriority(metadata.priority)
      for (const [key, value] of Object.entries(metadata))
        if (key !== "rule" && key !== "namespace" && key !== "handler")
          instance[key] = decode(value, instance, 0, key === "task")
      // 命名空间归属由可信加载器指定，不由插件指定。
      instance.namespace = namespace
      if (instance.task) {
        const tasks = Array.isArray(instance.task) ? instance.task : [instance.task]
        for (const task of tasks)
          if (typeof task.fnc === "string" && task.fnc) {
            const method = task.fnc
            task.fnc = () => invoke(instance, method, [], undefined, false, true)
          }
      }
      if (metadata.handler) {
        const handlers = Array.isArray(metadata.handler)
          ? metadata.handler
          : Object.values(row(metadata.handler))
        instance.handler = handlers.map((value: unknown) => {
          const handler = row(value)
          const name = `guardCallback_${randomUUID().replaceAll("-", "")}`
          instance[name] = (...args: unknown[]) =>
            typeof handler.fn === "string"
              ? invoke(instance, handler.fn, args, undefined, true)
              : invoke(instance, "callback", args, row(handler.fn).id, true)
          return {
            ...handler,
            fn: name,
            ...(handler.priority === undefined
              ? {}
              : { priority: parseNativePriority(handler.priority) }),
          }
        })
      }
      if (!Array.isArray(metadata.rule) || metadata.rule.length > 256)
        throw new Error(M.nativeSandbox.rules)
      instance.rule = metadata.rule.map((item: unknown, index: number) => {
        const rule = row(item)
        if (typeof rule.fnc !== "string" || !descriptor.methods.includes(rule.fnc))
          throw new Error(M.nativeSandbox.ruleMethod)
        const copy: Row = {}
        for (const [key, value] of Object.entries(rule)) {
          if (!new Set(["reg", "fnc", "event", "log", "permission"]).has(key))
            throw new Error(M.nativeSandbox.ruleMetadata(key))
          if (key !== "reg") copy[key] = decode(value, instance)
        }
        // 可信占位符不参与匹配，核心桥接等待 testRule。
        const regexp = new RegExp("(?:)")
        owner.ruleMarkers.set(regexp, { client, classId: descriptor.id, ruleIndex: index })
        owner.matchers.set(regexp, async text => {
          const result = await client.request("native-match", {
            classId: descriptor.id,
            ruleIndex: index,
            text,
          })
          if (typeof result !== "boolean") throw new Error(M.nativeSandbox.matchResult)
          return result
        })
        copy.reg = regexp
        return copy
      })
    }

    class NativePluginProxy extends base {
      /** 创建代理插件实例。 */
      constructor() {
        super({})
        assign(this)
        // init 后只刷新两个加载器模板，不刷新消息实例。
        if (instances.size < 2) instances.add(this)
      }
    }
    // 原生插件显示名不能作为宿主基类共享上下文存储的键。
    Object.defineProperty(NativePluginProxy.prototype, "conKey", {
      value() {
        return namespace
      },
    })
    Object.defineProperty(NativePluginProxy.prototype, "getContext", {
      async value(this: Row, _type?: unknown, isGroup = false) {
        const values = row(
          await client.request("native-context", {
            classId: descriptor.id,
            isGroup,
            event: snapshotEvent(this.e),
          }),
        )
        const result: Row = Object.create(null)
        if (Object.keys(values).length > 64) throw new Error(M.nativeSandbox.contextMethods)
        for (const [method, value] of Object.entries(values)) {
          const handle = row(value)
          if (
            ["getContext", "conKey"].includes(method) ||
            (!descriptor.methods.includes(method) && method !== "resolveContext") ||
            handle.$type !== "NativeContext" ||
            typeof handle.id !== "string" ||
            !/^ctx-[0-9a-f-]{36}$/.test(handle.id) ||
            Object.keys(handle).some(key => !["$type", "id"].includes(key))
          )
            throw new Error(M.nativeSandbox.contextHandle)
          result[method] = Object.freeze({ $type: "NativeContext", id: handle.id })
        }
        return result
      },
    })
    const installMethods = (methods: string[]) => {
      for (const method of new Set([...methods, "resolveContext"])) {
        if (Object.hasOwn(NativePluginProxy.prototype, method)) continue
        Object.defineProperty(NativePluginProxy.prototype, method, {
          configurable: false,
          value(this: Row, ...args: unknown[]) {
            return invoke(this, method, args)
          },
        })
      }
    }
    installMethods(descriptor.methods)
    Object.defineProperty(NativePluginProxy, "name", {
      value: descriptor.name,
    })
    return NativePluginProxy
  }

  /** 接入核心加载器，把沙箱插件交给核心加载。 */
  attach(loader: Row): void {
    this.loader = loader
    const manager = this
    const hooks = LoaderHooks.of(loader)
    // JiuLi 在一条消息内复用插件实例，须在消息结束时统一释放沙箱侧实例。
    const scoped =
      detectCoreProfile(this.root).id === "jiuli" &&
      this.settings.pluginSandbox.native.plugins.some(item => item.enabled)
    if (
      scoped &&
      !hooks.around("deal", (next, ...args: unknown[]) => {
        const scope = new Map<object, MessageInstance>()
        return manager.messageScope.run(scope, async () => {
          try {
            return await next(...args)
          } finally {
            await manager.releaseInstances(scope)
          }
        })
      })
    )
      throw new Error(M.runtime.loaderExport)
    hooks.around(
      "importPlugin",
      async function (next, file: { name: string; path: string }, packageErrors?: unknown[]) {
        if (!manager.configuration(file.name)) return next(file, packageErrors)
        const selected = manager.configuration(file.name)!
        if (manager.loadedFiles.get(selected.id)?.has(file.name)) {
          if (/[?#]/.test(file.path)) {
            const logger = Reflect.get(globalThis, "logger") as Row | undefined
            logger?.warn?.(M.nativeSandbox.restartToApply(file.name))
            return false
          }
          return true
        }
        let client: NativePluginClient | undefined
        this.pluginCountMap.set(file.name, 0)
        const start = performance.now()
        try {
          client = manager.client(file.name)
          if (/[?#]/.test(file.path)) throw new Error(M.nativeSandbox.sourceRestart)
          const entry = fs.realpathSync.native(path.resolve(manager.root, "lib/plugins", file.path))
          const relative = path.relative(client.pluginRoot, entry)
          if (
            !relative ||
            relative.startsWith(`..${path.sep}`) ||
            relative === ".." ||
            path.isAbsolute(relative)
          )
            throw new Error(M.nativeSandbox.entryEscapes)
          const result = await client.load(entry)
          if (!result.classes.length) throw new Error(M.nativeSandbox.noClasses(file.name))
          manager.registrations.reserve(client.config.id, file.name, result.classes)
          for (const descriptor of result.classes)
            await this.loadPlugin(file, manager.constructorProxy(client, descriptor, file.name))
          const files = manager.loadedFiles.get(client.config.id) ?? new Set<string>()
          files.add(file.name)
          manager.loadedFiles.set(client.config.id, files)
          return true
        } catch (error) {
          const logger = Reflect.get(globalThis, "logger") as Row | undefined
          logger?.error?.(M.nativeSandbox.loadError(file.name, String((error as Error).message)))
          // 失败时拒绝加载，错误路径不得调用原导入器。
          const config = manager.configuration(file.name)!
          manager.failedPlugins.add(config.id)
          const affected = new Set<string>([
            file.name,
            ...(manager.loadedFiles.get(config.id) ?? []),
          ])
          for (const item of this.priority as Row[])
            if (manager.configuration(item.key)?.id === config.id) affected.add(item.key)
          let rollbackFailed = false
          for (const key of affected) {
            try {
              await Reflect.apply(originalUnload, this, [key])
            } catch (cleanupError) {
              rollbackFailed = true
              logger?.error?.(M.nativeSandbox.removeFailed(key, (cleanupError as Error).message))
            }
          }
          if (rollbackFailed) {
            manager.loadedFiles.set(config.id, affected)
            manager.emit({
              kind: "plugin-sandbox",
              plugin: config.id,
              operation: "native.registration-cleanup-unconfirmed",
              target: config.id,
              action: "restart",
            })
          } else {
            manager.loadedFiles.delete(config.id)
            manager.registrations.release(config.id)
          }
          await client?.close()
          manager.clients.delete(config.id)
          return false
        } finally {
          this.load_time[file.name] = performance.now() - start
        }
      },
    )
    const originalUnload = hooks.original("unloadPlugin")!
    this.originalUnload = originalUnload
    hooks.around("unloadPlugin", async (next, key: string, ...args: unknown[]) => {
      let unloaded = false
      try {
        const result = await next(key, ...args)
        unloaded = true
        return result
      } finally {
        const config = manager.configuration(key)
        if (config) {
          if (!unloaded) {
            manager.emit({
              kind: "plugin-sandbox",
              plugin: config.id,
              operation: "native.registration-cleanup-unconfirmed",
              target: config.id,
              action: "restart",
            })
            await manager.clients.get(config.id)?.close()
          } else {
            manager.registrations.release(config.id, key)
            const files = manager.loadedFiles.get(config.id)
            files?.delete(key)
            if (!files?.size) {
              await manager.clients.get(config.id)?.close()
              manager.clients.delete(config.id)
              manager.loadedFiles.delete(config.id)
            }
          }
        }
      }
    })
    hooks.around("changePlugin", (next, key: string, ...args: unknown[]) => {
      if (!manager.configuration(key)) return next(key, ...args)
      // 核心私有卸载路径绕过公开生命周期桥接，因此保留旧
      // 进程直至完整受控重启，不将修改后的源码重新加载到核心。
      const logger = Reflect.get(globalThis, "logger") as Row | undefined
      logger?.warn?.(M.nativeSandbox.restartToApply(key))
      return false
    })
  }

  /** 关闭全部沙箱会话。 */
  async close(): Promise<void> {
    // 关闭插件进程前，先取消调度任务并注销 Handler。
    let unloadError: unknown
    for (const files of [...this.loadedFiles.values()])
      for (const file of [...files])
        try {
          await this.loader?.unloadPlugin(file)
        } catch (error) {
          unloadError ??= error
        }
    const results = await Promise.allSettled(
      [...this.clients.values()].map(client => client.close()),
    )
    this.clients.clear()
    const failure = results.find(result => result.status === "rejected")
    if (failure?.status === "rejected") throw failure.reason
    if (unloadError) throw unloadError
  }
}
