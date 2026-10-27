import fs from "node:fs"
import path from "node:path"
import { createRequire, registerHooks } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { AsyncLocalStorage } from "node:async_hooks"
import { installNativeCoreApi, installNativeCoreLoaderFacade } from "./core-loader-guest.js"
import { detectCoreProfile } from "../monitor/loader.js"
import { randomUUID } from "node:crypto"
import { NativeAdapterGuest } from "./adapter-guest.js"
import type { AdapterMethodCall } from "./adapter-protocol.js"
import { NativeMediaGuest } from "./media-guest.js"
import { NativeMediaSourceGuest } from "./media-source-guest.js"
import { encodeNativePriority } from "./priority.js"
import { parseNativeBotSnapshot } from "./bot-snapshot.js"
import type { AdapterId } from "./adapter-protocol.js"
import { NativeBotEventsGuest } from "./bot-events-guest.js"
import { botEventSessionId } from "./bot-events-protocol.js"
import { restoreNativeEventFlags } from "./event-flags-guest.js"

import { ProtocolError, toDto, fromDto, type Dto, type Channel } from "./protocol.js"
import { within } from "../protect/paths.js"
import { M } from "../shared/messages.js"
export {
  ProtocolError as NativeGuestError,
  maxFrameBytes as maxNativeFrameBytes,
  toDto,
  fromDto,
  type Dto,
  type Channel as GuestChannel,
} from "./protocol.js"

type Constructor = new (...args: unknown[]) => Record<string, unknown>
interface LoadedClass {
  constructor: Constructor
  initial: Record<string, unknown>
  missingRuleMethod: string
  missingRules: WeakMap<object, string>
  callbacks: Map<string, (...args: unknown[]) => unknown>
  callbackIds: WeakMap<(...args: unknown[]) => unknown, string>
  patterns: Map<number, { source: unknown; pattern: RegExp }>
  ruleMethods: Map<string, number>
  ruleAliases: Map<number, string>
  constructorRules: Map<number, unknown>
  instances: Map<string, { instance: Record<string, unknown>; event: Record<string, unknown> }>
  unloaded: boolean
}
interface ContextHandle {
  classId: string
  method: string
  value: unknown
  expires: number
}
const metadataKeys = ["name", "dsc", "event", "priority", "rule", "task", "handler", "namespace"]
const redisMethods = [
  "get",
  "set",
  "del",
  "exists",
  "keys",
  "expire",
  "pExpire",
  "ttl",
  "pTTL",
  "incr",
  "decr",
  "incrBy",
  "decrBy",
  "hGet",
  "hSet",
  "hGetAll",
  "hDel",
  "hExists",
  "sAdd",
  "sRem",
  "sMembers",
  "sIsMember",
  "lPush",
  "rPush",
  "lPop",
  "rPop",
  "lRange",
  "zRange",
  "zRangeWithScores",
  "zRevRank",
  "zAdd",
  "zRem",
]
// Windows 启动器在应用 ACL 前核验规范根路径；即使最终文件可读，
// AppContainer 也可能无权查询祖先元数据；可信别名表恢复模块规范位置，
// 并通过 --preserve-symlinks 避免查询这些祖先路径。
const appContainerPaths =
  process.platform === "win32" &&
  process.env.YUNZAI_GUARD_SANDBOX === "appcontainer" &&
  process.env.YUNZAI_GUARD_PIPE?.startsWith("\\\\.\\pipe\\yunzai-guard-") &&
  process.execArgv.includes("--preserve-symlinks")
/** 返回规范化的真实路径。 */
const canonical = (file: string) =>
  appContainerPaths ? path.resolve(file) : fs.realpathSync.native(path.resolve(file))

export class NativeGuest {
  private readonly calls = new AsyncLocalStorage<{
    id: string
    event?: Record<string, unknown>
    botEventReply?: boolean
  }>()
  private readonly classes = new Map<string, LoadedClass>()
  private readonly contexts = new Map<string, ContextHandle>()
  private root?: string
  private pluginRoot?: string
  private initializePromise?: Promise<void>
  private base?: Constructor
  private cleanupSymbol?: symbol
  private callbackCount = 0
  private hookAction: "audit" | "deny" | "restart" = "deny"
  private adaptersEnabled = false
  private adapter?: NativeAdapterGuest
  private botEvents?: NativeBotEventsGuest
  private botEventsSessionId?: string
  private readonly media: NativeMediaGuest
  private readonly mediaSource: NativeMediaSourceGuest
  private readonly botIds: AdapterId[] = []
  private jiuli = false
  private instanceCount = 0

  /** 创建沙箱内的插件运行端。 */
  constructor(private readonly channel: Channel) {
    this.media = new NativeMediaGuest((...args) => channel.service(...args))
    this.mediaSource = new NativeMediaSourceGuest((...args) => channel.service(...args))
  }

  /** 等待宿主处理回复。 */
  private async reply(requestId: string, args: unknown[]): Promise<unknown> {
    const prepared = await this.media.prepareReply(requestId, args)
    return this.channel.service("event", "reply", prepared, requestId)
  }

  /** 更新沙箱内的 Bot 快照。 */
  updateBotSnapshot(input: unknown): void {
    const snapshot = parseNativeBotSnapshot(input)
    this.botIds.splice(0, this.botIds.length, ...snapshot.uin)
  }

  /** 对沙箱不支持的接口抛错。 */
  private unsupported(target: string): never {
    throw new ProtocolError("UNSUPPORTED_API", M.nativeSandbox.unavailable(target))
  }

  /** 创建冻结的隔离 API 对象。 */
  private isolatedApi(name: string, values: Record<string, unknown>, allowUnknown = false): object {
    const change = (property: PropertyKey, apply: () => boolean): boolean => {
      this.channel.send({ type: "native-hook", target: `${name}.${String(property)}` })
      if (this.hookAction === "audit") return apply()
      throw new ProtocolError("HOST_HOOK_DENIED", M.nativeSandbox.readonly(name, String(property)))
    }
    const api: Record<string, unknown> = new Proxy(values, {
      get: (target, property) => {
        if (property === "then" || property === Symbol.toStringTag) return undefined
        if (Object.hasOwn(target, property)) return Reflect.get(target, property)
        if (allowUnknown) return undefined
        return this.unsupported(`${name}.${String(property)}`)
      },
      set: (target, property, value, receiver): boolean =>
        receiver !== api
          ? Reflect.set(target, property, value, receiver)
          : change(property, () => Reflect.set(target, property, value)),
      defineProperty: (target, property, descriptor) =>
        change(property, () => Reflect.defineProperty(target, property, descriptor)),
      deleteProperty: (target, property) =>
        change(property, () => Reflect.deleteProperty(target, property)),
      setPrototypeOf: (target, prototype) =>
        change("__proto__", () => Reflect.setPrototypeOf(target, prototype)),
    })
    return api
  }

  /** 初始化核心 API 副本与模块解析。 */
  private async initialize(root: string): Promise<void> {
    process.chdir(root)
    this.jiuli = detectCoreProfile(root).id === "jiuli"
    const globals = globalThis as unknown as Record<string, unknown>
    const sleepTimeout = Symbol("timeout")
    const sleep = (ms: number, promise?: Promise<unknown>): Promise<unknown> =>
      promise
        ? Promise.race([promise, sleep(ms)])
        : new Promise(resolve => setTimeout(resolve, ms, sleepTimeout))
    const log = (level: string, ...args: unknown[]) =>
      this.channel.send({ type: "native-log", level, args: toDto(args) })
    const logger: Record<string, unknown> = Object.create(null)
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal", "mark"])
      logger[level] = (...args: unknown[]) => log(level, ...args)
    for (const color of [
      "red",
      "green",
      "blue",
      "cyan",
      "yellow",
      "magenta",
      "white",
      "gray",
      "grey",
      "bold",
    ])
      logger[color] = (value: unknown) => String(value)
    const loggerApi = this.isolatedApi("logger", logger, true)
    logger.logger = loggerApi
    globals.logger = loggerApi
    const botValues: Record<string, unknown> = {
      uin: this.botIds,
      restart: (...args: unknown[]) =>
        this.channel.service("core", "restart", args, this.calls.getStore()?.id),
      logger: loggerApi,
      fsStat: async (file: string) => {
        try {
          return await fs.promises.stat(file)
        } catch {
          return false
        }
      },
      mkdir: (directory: string) => fs.promises.mkdir(directory, { recursive: true }),
      String: (value: unknown) =>
        typeof value === "string" ? value : (JSON.stringify(value) ?? String(value)),
      sleep,
      sleepTimeout,
      makeLog: (level: string, value: unknown, id?: unknown) => log(level, id, value),
      makeForwardMsg: (messages: unknown) => ({ type: "node", data: messages }),
      makeForwardArray: (
        messages: unknown[] | unknown = [],
        node: Record<string, unknown> = {},
      ) => ({
        type: "node",
        data: (Array.isArray(messages) ? messages : [messages]).map(message => ({
          ...node,
          message,
        })),
      }),
    }
    const botApi = this.isolatedApi("Bot", botValues)
    let bot: unknown = botApi
    if (this.adaptersEnabled) {
      const adapter = (this.adapter = new NativeAdapterGuest(frame =>
        this.channel.send({ type: "native-adapter", frame }),
      ))
      botValues.adapter = adapter.adapter
      botValues.uin = adapter.connectedIds
      botValues.em = (name: string, event: unknown) => adapter.emit(name, event)
      bot = new Proxy(botApi, {
        get: (target, key, receiver) =>
          typeof key === "string" && !Object.hasOwn(botValues, key) && adapter.hasAccount(key)
            ? adapter.getAccount(key)
            : Reflect.get(target, key, receiver),
        set: (target, key, value, receiver) => {
          if (
            typeof key === "string" &&
            !Object.hasOwn(botValues, key) &&
            value &&
            typeof value === "object"
          ) {
            adapter.setAccount(key, value)
            return true
          }
          return Reflect.set(target, key, value, receiver)
        },
        deleteProperty: (target, key) => {
          if (typeof key === "string" && adapter.hasAccount(key)) {
            adapter.removeAccount(key)
            return true
          }
          return Reflect.deleteProperty(target, key)
        },
      })
    }
    if (this.botEvents) {
      const events = this.botEvents.bindThis(bot as object)
      for (const name of ["on", "once", "off", "removeListener", "removeAllListeners"] as const)
        botValues[name] = (...args: unknown[]) => {
          Reflect.apply(events[name], events, args)
          return bot
        }
      botValues.addListener = botValues.on
    }
    Object.defineProperty(globals, "Bot", {
      configurable: false,
      get: () => bot,
      set: value => {
        this.channel.send({ type: "native-hook", target: "Bot" })
        if (this.hookAction === "audit") {
          bot = value
          return
        }
        throw new ProtocolError("HOST_HOOK_DENIED", M.nativeSandbox.replaceBot)
      },
    })
    const redis: Record<string, unknown> = Object.create(null)
    for (const method of redisMethods)
      redis[method] = (...args: unknown[]) =>
        this.channel.service("redis", method, args, this.calls.getStore()?.id)
    globals.redis = this.isolatedApi("redis", redis)

    const coreLibrary = canonical(path.join(root, "lib"))
    installNativeCoreLoaderFacade(this.isolatedApi("PluginsLoader", {}))
    const loaderLocation = path.join(coreLibrary, "plugins/loader.js")
    const jiuliLoaderLocation = path.join(coreLibrary, "core/loader.js")
    const jiuliIndexLocation = path.join(coreLibrary, "core/index.js")
    const loaderFacadeUrl = new URL("./core-loader-guest.js", import.meta.url).href
    const coreFacadeUrl = new URL("./core-api-guest.js", import.meta.url).href
    const allowedCore = new Set(
      [
        "plugins/plugin.js",
        "plugins/config.js",
        "plugins/runtime.js",
        "plugins/handler.js",
        "config/config.js",
        "common/common.js",
        "util.js",
        "puppeteer/puppeteer.js",
        ...(this.jiuli
          ? [
              "index.js",
              "core/plugin.js",
              "core/plugin-config.js",
              "core/config/index.js",
              "core/util.js",
              "core/log.js",
              "core/segment.js",
              "core/metrics.js",
              "core/runtime.js",
              "core/handler.js",
              "core/common.js",
              "core/render/index.js",
              "core/render/Renderer.js",
            ]
          : []),
      ].map(file => path.normalize(path.join(coreLibrary, file))),
    )
    const fold = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)
    const allowedFolded = new Set([...allowedCore].map(fold))
    const jiuli = this.jiuli
    registerHooks({
      /** 把核心模块解析到沙箱内的副本。 */
      resolve(specifier, context, nextResolve) {
        const packageEntry = jiuli
          ? specifier === "jiuli"
            ? pathToFileURL(path.join(coreLibrary, "index.js")).href
            : specifier === "jiuli/core"
              ? pathToFileURL(jiuliIndexLocation).href
              : specifier
          : specifier
        const result = nextResolve(packageEntry, context)
        if (!result.url.startsWith("file:")) return result
        const location = canonical(fileURLToPath(result.url))
        if (
          fold(location) === fold(loaderLocation) ||
          (jiuli && fold(location) === fold(jiuliLoaderLocation))
        )
          return { ...result, url: loaderFacadeUrl }
        if (jiuli && fold(location) === fold(jiuliIndexLocation))
          return { ...result, url: coreFacadeUrl }
        if (
          fold(location) === fold(path.join(root, "app.js")) ||
          (within(coreLibrary, location) &&
            !allowedFolded.has(fold(location)) &&
            !within(path.join(coreLibrary, "modules"), location) &&
            !within(path.join(coreLibrary, "renderer"), location))
        )
          throw new ProtocolError(
            "CORE_IMPORT_DENIED",
            M.nativeSandbox.coreModule(path.relative(root, location)),
          )
        return result
      },
    })
    let coreLog: Record<string, any> | undefined
    if (this.jiuli) {
      coreLog = await import(pathToFileURL(path.join(coreLibrary, "core/log.js")).href)
      // 插件日志经进程输出收集，不给本地核心副本额外授权共享日志目录。
      coreLog!.logger.setWriteFile(false)
    }
    const require = createRequire(path.join(root, "package.json"))
    const lodash = await import(pathToFileURL(require.resolve("lodash")).href)
    const oicq = await import(pathToFileURL(require.resolve("oicq")).href)
    globals.lodash = lodash.default ?? lodash
    globals.segment = oicq.segment ?? oicq.default?.segment
    if (!globals.segment) throw new ProtocolError("MISSING_DEPENDENCY", M.nativeSandbox.oicqSegment)
    const utilityFile = path.join(coreLibrary, "util.js")
    if (fs.existsSync(utilityFile)) {
      // 这些核心原方法仅在当前受限进程中执行。
      // 不向其传入活动宿主 Bot 或可调用宿主对象。
      const utility = (await import(pathToFileURL(utilityFile).href)).default
      for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(utility))) {
        const method = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(utility), name)?.value
        if (
          name !== "constructor" &&
          typeof method === "function" &&
          !Object.hasOwn(botValues, name)
        )
          botValues[name] = method.bind(utility)
      }
    }
    const base = await import(pathToFileURL(path.join(coreLibrary, "plugins/plugin.js")).href)
    if (typeof base.default !== "function")
      throw new ProtocolError("INVALID_CORE", M.nativeSandbox.pluginClassMissing)
    this.base = base.default as Constructor
    this.cleanupSymbol = typeof base.PluginCleanup === "symbol" ? base.PluginCleanup : undefined
    globals.plugin = this.base
    if (this.jiuli) {
      const api = await import(pathToFileURL(path.join(coreLibrary, "index.js")).href)
      const renderer = await import(
        pathToFileURL(path.join(coreLibrary, "core/render/index.js")).href
      )
      const template = await import(
        pathToFileURL(path.join(coreLibrary, "core/render/Renderer.js")).href
      )
      const segment = await import(pathToFileURL(path.join(coreLibrary, "core/segment.js")).href)
      installNativeCoreApi({
        BasePlugin: this.base,
        ...Object.fromEntries(
          ["cfg", "util", "Handler", "Runtime", "metrics", "renderService", "logger", "chalk"].map(
            key => [key, api[key]],
          ),
        ),
        RendererLoader: renderer.RendererLoader,
        TemplateRenderer: template.default,
        segment: segment.default,
        getSegment: segment.getSegment,
        extendSegment: segment.extendSegment,
        setLog: coreLog!.setLog,
      })
    } else installNativeCoreApi({})
  }

  /** 提取插件实例的元数据。 */
  private metadata(instance: Record<string, unknown>, loaded: LoadedClass): Dto {
    const replaceCallbacks = (value: unknown, seen = new Set<object>(), depth = 0): unknown => {
      if (depth > 20) throw new ProtocolError("UNSUPPORTED_METADATA", M.nativeSandbox.metadataDepth)
      if (typeof value === "function") {
        const callback = value as (...args: unknown[]) => unknown
        let id = loaded.callbackIds.get(callback)
        if (!id) {
          if (this.callbackCount >= 64)
            throw new ProtocolError("CALLBACK_LIMIT", M.nativeSandbox.functionHandles)
          id = `cb-${randomUUID()}`
          loaded.callbackIds.set(callback, id)
          loaded.callbacks.set(id, callback)
          this.callbackCount++
        }
        return { $type: "NativeFunction", id }
      }
      if (!value || typeof value !== "object" || value instanceof RegExp) return value
      if (seen.has(value))
        throw new ProtocolError("UNSUPPORTED_METADATA", M.nativeSandbox.metadataCycle)
      if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw new ProtocolError("UNSUPPORTED_METADATA", M.nativeSandbox.metadataObject)
      seen.add(value)
      try {
        if (Array.isArray(value)) return value.map(item => replaceCallbacks(item, seen, depth + 1))
        return Object.fromEntries(
          Object.keys(value).flatMap(key => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key)!
            if (!Object.hasOwn(descriptor, "value"))
              throw new ProtocolError("UNSUPPORTED_METADATA", M.nativeSandbox.metadataAccessor)
            if (descriptor.value === undefined) return []
            return [
              [
                key,
                key === "priority"
                  ? encodeNativePriority(descriptor.value)
                  : replaceCallbacks(descriptor.value, seen, depth + 1),
              ],
            ]
          }),
        )
      } finally {
        seen.delete(value)
      }
    }
    return toDto(
      Object.fromEntries(
        metadataKeys
          .filter(key => instance[key] !== undefined)
          .map(key => [
            key,
            key === "priority"
              ? encodeNativePriority(instance[key])
              : key === "rule" && Array.isArray(instance[key])
                ? instance[key].map((rule, index) =>
                    rule && typeof rule === "object" && !Array.isArray(rule)
                      ? {
                          ...Object.fromEntries(
                            Object.entries(rule).filter(
                              ([key, value]) =>
                                value !== undefined && !(this.jiuli && key === "priority"),
                            ),
                          ),
                          reg: this.rulePattern(rule.reg),
                          fnc: this.ruleMethod(instance, rule, loaded, index),
                        }
                      : rule,
                  )
                : key === "task" || key === "handler"
                  ? replaceCallbacks(
                      this.jiuli && key === "handler"
                        ? this.handlers(instance[key])
                        : instance[key],
                    )
                  : instance[key],
          ]),
      ),
      true,
    )
  }

  /** 规范化插件声明的处理器。 */
  private handlers(value: unknown): unknown {
    const list = Array.isArray(value)
      ? value
      : value && typeof value === "object" && "key" in value
        ? [value]
        : Object.values(value as Record<string, unknown>)
    return list.map(handler => {
      if (!handler || typeof handler !== "object" || Array.isArray(handler)) return handler
      const record = handler as Record<string, unknown>
      if (record.fn !== undefined || record.fnc === undefined) return record
      const { fnc, ...metadata } = record
      return { ...metadata, fn: fnc }
    })
  }

  /** 编译规则正则。 */
  private rulePattern(source: unknown): RegExp {
    // 原加载器在 reg 缺失时也执行 new RegExp，例如通知处理器。
    // 该转换和正则执行均留在受限插件进程内。
    return source instanceof RegExp
      ? source
      : new RegExp(source === undefined ? "" : (source as string))
  }

  /** 判断规则方法是否缺失。 */
  private missingRule(instance: Record<string, unknown>, name: unknown): boolean {
    return (
      typeof name === "string" &&
      name.length > 0 &&
      name.length <= 128 &&
      !["constructor", "prototype", "__proto__", "then"].includes(name) &&
      instance[name] === undefined
    )
  }

  /** 为规则取得可调用方法。 */
  private ruleMethod(
    instance: Record<string, unknown>,
    rule: Record<string, unknown>,
    loaded: LoadedClass,
    index: number,
  ): unknown {
    const name = rule.fnc
    if (this.jiuli && typeof name === "function") {
      let alias = loaded.ruleAliases.get(index)
      if (!alias) {
        alias = `guardRule_${randomUUID().replaceAll("-", "")}`
        if (Reflect.has(instance, alias))
          throw new ProtocolError("METHOD_ALIAS_COLLISION", M.nativeSandbox.missingRuleReserve)
        loaded.ruleAliases.set(index, alias)
        loaded.ruleMethods.set(alias, index)
      }
      return alias
    }
    if (
      (typeof name === "string" && loaded.missingRules.get(rule) === name) ||
      this.missingRule(instance, name)
    ) {
      // name/e 等数据字段可能在 init 或请求中才出现；已有缺失规则
      // 继续使用空操作别名，fnc 改为其他方法时重新校验。
      loaded.missingRules.set(rule, name as string)
      return loaded.missingRuleMethod
    }
    return name
  }

  /** 为缺失的规则方法分配占位名。 */
  private allocateMissingRuleMethod(instance: Record<string, unknown>): string {
    // 保持现有 256 个业务方法预算，协议额外预留一个别名。
    this.methods(instance)
    for (let attempt = 0; attempt < 8; attempt++) {
      const alias = `guardMissingRule_${randomUUID().replaceAll("-", "")}`
      if (!Reflect.has(instance, alias)) return alias
    }
    throw new ProtocolError("METHOD_ALIAS_COLLISION", M.nativeSandbox.missingRuleReserve)
  }

  /** 列出插件实例的可调用方法。 */
  private methods(
    instance: Record<string, unknown>,
    missingRuleMethod?: string,
    loaded?: LoadedClass,
  ): string[] {
    const methods = new Set<string>()
    let object: object | null = instance
    while (object && object !== this.base?.prototype && object !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(object)) {
        const descriptor = Object.getOwnPropertyDescriptor(object, name)
        if (name !== "constructor" && typeof descriptor?.value === "function") methods.add(name)
      }
      object = Object.getPrototypeOf(object)
    }
    if (this.jiuli && typeof instance.init === "function") methods.add("init")
    if (loaded) for (const alias of loaded.ruleMethods.keys()) methods.add(alias)
    if (methods.size > 256) throw new ProtocolError("METHOD_LIMIT", M.nativeSandbox.methodLimit)
    if (missingRuleMethod) {
      if (Reflect.has(instance, missingRuleMethod))
        throw new ProtocolError("METHOD_ALIAS_COLLISION", M.nativeSandbox.missingRuleOverwritten)
      // 即使 init 尚未补齐缺失规则也始终存在，不安装其原始名称。
      methods.add(missingRuleMethod)
    }
    return [...methods]
  }

  /** 绑定实例上的事件对象。 */
  private bindEvent(instance: Record<string, unknown>): void {
    const descriptor = Object.getOwnPropertyDescriptor(instance, "e")
    if (descriptor && (!descriptor.configurable || !Object.hasOwn(descriptor, "value")))
      throw new ProtocolError("UNSUPPORTED_METADATA", M.nativeSandbox.initializerEvent)
    const calls = this.calls
    let fallback = descriptor?.value
    Object.defineProperty(instance, "e", {
      configurable: false,
      enumerable: descriptor?.enumerable ?? true,
      get: () => calls.getStore()?.event ?? fallback,
      set: value => {
        const context = calls.getStore()
        if (context) context.event = value
        else fallback = value
      },
    })
  }

  /** 加载插件入口并登记导出的插件类。 */
  async load(
    requestId: string,
    rootInput: string,
    pluginInput: string,
    entryInput: string,
    hookAction: "audit" | "deny" | "restart" = "deny",
    adapters = false,
    eventsSessionId?: string,
  ): Promise<unknown> {
    return this.calls.run({ id: requestId }, async () => {
      const root = canonical(rootInput),
        pluginRoot = canonical(pluginInput)
      if (!within(path.join(root, "plugins"), pluginRoot))
        throw new ProtocolError("INVALID_ROOT", M.nativeSandbox.pluginDirScope)
      if (this.root && (root !== this.root || pluginRoot !== this.pluginRoot))
        throw new ProtocolError("ROOT_CHANGED", M.nativeSandbox.pluginDirSwitch)
      this.root = root
      this.pluginRoot = pluginRoot
      if (
        this.initializePromise &&
        (hookAction !== this.hookAction ||
          adapters !== this.adaptersEnabled ||
          eventsSessionId !== this.botEventsSessionId)
      )
        throw new ProtocolError("POLICY_CHANGED", M.nativeSandbox.hookPolicyChange)
      this.hookAction = hookAction
      this.adaptersEnabled = adapters
      if (eventsSessionId !== undefined && !this.botEvents) {
        this.botEventsSessionId = botEventSessionId(eventsSessionId)
        this.botEvents = new NativeBotEventsGuest(
          frame => this.channel.send({ type: "native-bot-events", frame }),
          {
            sessionId: this.botEventsSessionId,
            restoreArgs: args => {
              const event = args[0]
              const context = this.calls.getStore()
              if (event && typeof event === "object" && !Array.isArray(event) && context) {
                const restored: Record<string, unknown> = { ...event }
                restoreNativeEventFlags(restored)
                if (context.botEventReply)
                  restored.reply = (...reply: unknown[]) => this.reply(context.id, reply)
                context.event = restored
                return [restored, ...args.slice(1)]
              }
              return args
            },
          },
        )
      }
      this.initializePromise ??= this.initialize(root)
      await this.initializePromise
      const entry = canonical(path.resolve(pluginRoot, entryInput))
      if (!within(pluginRoot, entry))
        throw new ProtocolError("INVALID_ENTRY", M.nativeSandbox.entryEscape)
      const module = await import(pathToFileURL(entry).href)
      const exports = module.apps || module
      const result = []
      for (const [key, value] of Object.entries(exports)) {
        if (typeof value !== "function" || !value.prototype) continue
        const id = `${path.relative(pluginRoot, entry).split(path.sep).join("/")}#${key}`
        let loaded = this.classes.get(id)
        if (!loaded) {
          const constructor = value as Constructor
          const initial = new constructor()
          const constructorRules = new Map<number, unknown>()
          if (Array.isArray(initial.rule))
            for (let index = 0; index < Math.min(initial.rule.length, 256); index++) {
              const rule = initial.rule[index]
              if (!rule || typeof rule !== "object") continue
              const property = Object.getOwnPropertyDescriptor(rule, "fnc")
              if (property && "value" in property) constructorRules.set(index, property.value)
            }
          this.bindEvent(initial)
          loaded = {
            constructor,
            initial,
            missingRuleMethod: this.allocateMissingRuleMethod(initial),
            missingRules: new WeakMap(),
            callbacks: new Map(),
            callbackIds: new WeakMap(),
            patterns: new Map(),
            ruleMethods: new Map(),
            ruleAliases: new Map(),
            constructorRules,
            instances: new Map(),
            unloaded: false,
          }
          this.classes.set(id, loaded)
        }
        result.push({
          id,
          name: loaded.constructor.name,
          metadata: this.metadata(loaded.initial, loaded),
          methods: this.methods(loaded.initial, loaded.missingRuleMethod, loaded),
        })
      }
      return { classes: result, pid: process.pid }
    })
  }

  /** 调用插件实例方法。 */
  async call(
    requestId: string,
    classId: string,
    method: string,
    eventInput?: unknown,
    argsInput?: unknown[],
    eventArgsInput?: unknown[],
    handlerReject = false,
    contextHandle?: string,
    instanceId?: string,
    ruleIndex?: number,
  ): Promise<unknown> {
    return this.calls.run({ id: requestId }, async () => {
      const loaded = this.classes.get(classId)
      if (!loaded) throw new ProtocolError("UNKNOWN_CLASS", M.nativeSandbox.classUnknown(classId))
      const context = contextHandle ? this.contexts.get(contextHandle) : undefined
      if (
        contextHandle &&
        (!context ||
          context.classId !== classId ||
          context.method !== method ||
          context.expires < performance.now())
      )
        throw new ProtocolError("UNKNOWN_CONTEXT", M.nativeSandbox.contextCapability)
      if (contextHandle) this.contexts.delete(contextHandle)
      if (
        !this.methods(loaded.initial, loaded.missingRuleMethod, loaded).includes(method) &&
        !(method === "resolveContext" && context)
      )
        throw new ProtocolError("UNKNOWN_METHOD", M.nativeSandbox.methodNotExported(method))
      let event = (fromDto(eventInput ?? {}) ?? {}) as Record<string, unknown>
      if (typeof event !== "object" || Array.isArray(event))
        throw new ProtocolError("INVALID_EVENT", M.nativeSandbox.eventObject)
      const initializer = method === "init" || (this.jiuli && method === "onUnload")
      if (this.jiuli && method === "onUnload" && loaded.unloaded)
        return { result: null, metadata: this.metadata(loaded.initial, loaded) }
      let instance: Record<string, unknown> | undefined = initializer ? loaded.initial : undefined
      if (instanceId !== undefined && !initializer) {
        if (!this.jiuli || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(instanceId))
          throw new ProtocolError("INVALID_INSTANCE", M.nativeSandbox.instanceCleanup)
        const cached = loaded.instances.get(instanceId)
        if (cached) {
          Object.assign(cached.event, event)
          event = cached.event
          instance = cached.instance
        } else if (this.instanceCount >= 256)
          throw new ProtocolError("INSTANCE_LIMIT", M.nativeSandbox.messageInstances)
      }
      restoreNativeEventFlags(event)
      event.reply = (...args: unknown[]) => this.reply(this.calls.getStore()!.id, args)
      this.calls.getStore()!.event = event
      if (!instance) {
        instance = new loaded.constructor(event)
        this.bindEvent(instance)
        if (instanceId !== undefined) {
          loaded.instances.set(instanceId, { instance, event })
          this.instanceCount++
        }
      }
      instance.e = event
      let args = context
        ? [context.value]
        : eventArgsInput !== undefined
          ? [event, ...(fromDto(eventArgsInput) as unknown[])]
          : argsInput === undefined
            ? initializer
              ? []
              : [event]
            : (fromDto(argsInput) as unknown[])
      if (handlerReject)
        args.push((message = "") =>
          this.channel.service("event", "handlerReject", [message], requestId),
        )
      if (method === loaded.missingRuleMethod)
        return { result: null, metadata: this.metadata(loaded.initial, loaded) }
      const aliasIndex = loaded.ruleMethods.get(method)
      const rule =
        aliasIndex === undefined
          ? undefined
          : (instance.rule as Record<string, unknown>[])?.[aliasIndex]
      const registeredRule =
        aliasIndex === undefined
          ? undefined
          : (loaded.initial.rule as Record<string, unknown>[])?.[aliasIndex]
      const ruleFunction = (value: Record<string, unknown> | undefined) =>
        typeof value?.fnc === "string" ? instance[value.fnc] : value?.fnc
      const currentRuleFunction = ruleFunction(rule)
      const fn =
        aliasIndex === undefined
          ? instance[method]
          : typeof currentRuleFunction === "function" &&
              registeredRule?.fnc === loaded.constructorRules.get(aliasIndex)
            ? currentRuleFunction
            : ruleFunction(registeredRule)
      if (fn === undefined) return { result: null, metadata: this.metadata(loaded.initial, loaded) }
      if (typeof fn !== "function")
        throw new ProtocolError("UNKNOWN_METHOD", M.nativeSandbox.methodNotCallable)
      if (ruleIndex !== undefined) {
        const registeredRule = (loaded.initial.rule as Record<string, unknown>[])?.[ruleIndex]
        if (
          !this.jiuli ||
          context ||
          !registeredRule ||
          (aliasIndex === undefined ? registeredRule.fnc !== method : aliasIndex !== ruleIndex)
        )
          throw new ProtocolError("UNKNOWN_RULE", M.nativeSandbox.ruleIndex)
        args =
          fn.length >= 2
            ? [event, this.pattern(loaded, ruleIndex).exec(String(event.msg)) || undefined]
            : [event]
      }
      if (this.jiuli && method === "onUnload") loaded.unloaded = true
      const result = await Reflect.apply(fn, instance, args)
      const metadata = this.metadata(loaded.initial, loaded)
      return {
        result: toDto(result),
        metadata,
        ...(method === "init"
          ? { methods: this.methods(loaded.initial, loaded.missingRuleMethod, loaded) }
          : {}),
      }
    })
  }

  /** 释放插件实例。 */
  releaseInstance(classId: string, instanceId: string): void {
    const loaded = this.classes.get(classId)
    if (!loaded || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(instanceId))
      throw new ProtocolError("INVALID_INSTANCE", M.nativeSandbox.instanceCleanup)
    if (loaded.instances.delete(instanceId)) this.instanceCount--
  }

  /** 调用插件的上下文处理方法。 */
  async context(
    requestId: string,
    classId: string,
    eventInput: unknown,
    isGroup: boolean,
  ): Promise<unknown> {
    return this.calls.run({ id: requestId }, async () => {
      const loaded = this.classes.get(classId)
      if (!loaded) throw new ProtocolError("UNKNOWN_CLASS", M.nativeSandbox.contextClass)
      const event = fromDto(eventInput ?? {}) as Record<string, unknown>
      if (!event || typeof event !== "object" || Array.isArray(event))
        throw new ProtocolError("INVALID_EVENT", M.nativeSandbox.contextEvent)
      restoreNativeEventFlags(event)
      // 查询本身没有回复能力，仅后续上下文方法获得该能力。
      this.calls.getStore()!.event = event
      const getContext = loaded.initial.getContext
      if (typeof getContext !== "function") return {}
      const values = await Reflect.apply(getContext, loaded.initial, [false, isGroup])
      if (values === undefined || values === null) return {}
      if (typeof values !== "object" || Array.isArray(values))
        throw new ProtocolError("INVALID_CONTEXT", M.nativeSandbox.contextMap)
      const entries = Object.entries(Object.getOwnPropertyDescriptors(values))
      if (entries.length > 64)
        throw new ProtocolError("CONTEXT_LIMIT", M.nativeSandbox.contextLimit)
      for (const [id, entry] of this.contexts)
        if (entry.expires < performance.now()) this.contexts.delete(id)
      const methods = this.methods(loaded.initial, loaded.missingRuleMethod, loaded)
      const result: Record<string, unknown> = Object.create(null)
      for (const [method, descriptor] of entries) {
        if (
          ["getContext", "conKey"].includes(method) ||
          !Object.hasOwn(descriptor, "value") ||
          (!methods.includes(method) && method !== "resolveContext")
        )
          throw new ProtocolError("INVALID_CONTEXT", M.nativeSandbox.contextMethod)
        if (this.contexts.size >= 256)
          throw new ProtocolError("CONTEXT_LIMIT", M.nativeSandbox.contextHandles)
        const id = `ctx-${randomUUID()}`
        this.contexts.set(id, {
          classId,
          method,
          value: descriptor.value,
          expires: performance.now() + 60000,
        })
        result[method] = { $type: "NativeContext", id }
      }
      return result
    })
  }

  /** 判断文本是否匹配插件规则。 */
  match(classId: string, ruleIndex: number, text: string): boolean {
    const loaded = this.classes.get(classId)
    if (!loaded) throw new ProtocolError("UNKNOWN_CLASS", M.nativeSandbox.classUnknown(classId))
    return this.pattern(loaded, ruleIndex).test(text)
  }

  /** 取得缓存的规则正则。 */
  private pattern(loaded: LoadedClass, ruleIndex: number): RegExp {
    const rules = loaded.initial.rule
    if (
      !Array.isArray(rules) ||
      !Number.isSafeInteger(ruleIndex) ||
      ruleIndex < 0 ||
      ruleIndex >= rules.length
    )
      throw new ProtocolError("UNKNOWN_RULE", M.nativeSandbox.ruleIndex)
    const source = rules[ruleIndex]?.reg
    let entry = loaded.patterns.get(ruleIndex)
    if (!entry || entry.source !== source) {
      entry = { source, pattern: this.rulePattern(source) }
      loaded.patterns.set(ruleIndex, entry)
    }
    return entry.pattern
  }

  /** 执行插件登记的回调。 */
  async callback(
    requestId: string,
    classId: string,
    handle: string,
    eventInput?: unknown,
    argsInput?: unknown[],
    eventArgsInput?: unknown[],
    handlerReject = false,
  ): Promise<unknown> {
    return this.calls.run({ id: requestId }, async () => {
      const loaded = this.classes.get(classId)
      const callback = loaded?.callbacks.get(handle)
      if (!loaded || !callback)
        throw new ProtocolError("UNKNOWN_CALLBACK", M.nativeSandbox.callbackUnknown)
      const event = (fromDto(eventInput ?? {}) ?? {}) as Record<string, unknown>
      if (typeof event !== "object" || Array.isArray(event))
        throw new ProtocolError("INVALID_EVENT", M.nativeSandbox.eventObject)
      restoreNativeEventFlags(event)
      event.reply = (...args: unknown[]) => this.reply(requestId, args)
      this.calls.getStore()!.event = event
      loaded.initial.e = event
      const args =
        eventArgsInput !== undefined
          ? [event, ...(fromDto(eventArgsInput) as unknown[])]
          : argsInput === undefined
            ? eventInput === undefined
              ? []
              : [event]
            : (fromDto(argsInput) as unknown[])
      if (handlerReject)
        args.push((message = "") =>
          this.channel.service("event", "handlerReject", [message], requestId),
        )
      const result = await Reflect.apply(callback, loaded.initial, args)
      return { result: toDto(result), metadata: this.metadata(loaded.initial, loaded) }
    })
  }

  /** 执行适配器方法调用。 */
  async adapterCall(requestId: string, call: AdapterMethodCall): Promise<unknown> {
    if (!this.adaptersEnabled || !this.adapter)
      throw new ProtocolError("ADAPTER_DENIED", M.nativeSandbox.adapterNotGranted)
    return this.calls.run({ id: requestId }, () =>
      this.adapter!.invoke(call, args => this.mediaSource.restoreArgs(requestId, args)),
    )
  }

  /** 执行 Bot 事件监听回调。 */
  async botEvent(
    requestId: string,
    handle: string,
    args: unknown[],
    eventReply: boolean,
  ): Promise<null> {
    if (!this.botEvents)
      throw new ProtocolError("BOT_EVENT_UNAVAILABLE", M.nativeSandbox.botEventUnavailable)
    return this.calls.run({ id: requestId, botEventReply: eventReply }, async () => {
      await this.botEvents!.dispatch(handle, args)
      return null
    })
  }

  /** 仅对明确注册到原核心基类的资源执行正常清理。 */
  async dispose(requestId: string): Promise<unknown> {
    return this.calls.run({ id: requestId }, async () => {
      const result = {
        initializers: this.classes.size,
        disposed: 0,
        failed: 0,
        errors: [] as Array<{ classId: string; code: string; message: string }>,
      }
      if (this.botEvents) {
        try {
          await this.botEvents.dispatchExit(["exit"])
        } catch {
          result.failed++
          result.errors.push({
            classId: "<Bot.exit>",
            code: "BOT_EXIT_FAILED",
            message: "Guest Bot exit listeners failed",
          })
        } finally {
          try {
            this.botEvents.close()
          } catch {
            result.failed++
            result.errors.push({
              classId: "<Bot.exit>",
              code: "BOT_EXIT_FAILED",
              message: "Guest Bot listener close failed",
            })
          }
        }
      }
      if (this.adapter) {
        const adapters = await this.adapter.dispose()
        result.disposed += adapters.accounts - adapters.logoutFailures
        result.failed += adapters.logoutFailures
      }
      for (const loaded of this.classes.values()) loaded.instances.clear()
      this.instanceCount = 0
      for (const [classId, loaded] of this.classes) {
        const failure = (error: unknown) => {
          result.failed++
          if (result.errors.length < 16)
            result.errors.push({
              classId,
              code: error instanceof ProtocolError ? error.code : "DISPOSE_FAILED",
              message: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
            })
        }
        if (this.jiuli && !loaded.unloaded && typeof loaded.initial.onUnload === "function") {
          loaded.unloaded = true
          try {
            await Reflect.apply(loaded.initial.onUnload, loaded.initial, [])
            result.disposed++
          } catch (error) {
            failure(error)
          }
        }
        if (!this.cleanupSymbol) continue
        let entries: unknown
        try {
          entries = Reflect.get(loaded.initial, this.cleanupSymbol)
        } catch (error) {
          failure(error)
          continue
        }
        if (entries === undefined) continue
        if (!Array.isArray(entries)) {
          failure(new ProtocolError("INVALID_CLEANUP", M.nativeSandbox.cleanupArray))
          continue
        }
        for (const entry of entries) {
          try {
            if (!entry?.active) continue
            entry.active = false
            if (typeof entry.dispose !== "function")
              throw new ProtocolError("INVALID_CLEANUP", M.nativeSandbox.disposeFunction)
            await Reflect.apply(entry.dispose, loaded.initial, [])
            result.disposed++
          } catch (error) {
            failure(error)
          }
        }
      }
      return result
    })
  }
}
