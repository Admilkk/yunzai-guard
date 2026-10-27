import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { evaluatePolicy, GuardDeniedError } from "../config/policy.js"
import { snapshotSettings } from "../config/index.js"
import { arrayEach, objectDefine } from "../protect/intrinsics.js"
import type { EmitEvent, GuardSettings } from "../shared/types.js"
import type { NativeSandboxPlugin, NativeLoadResult } from "./types.js"
import {
  launchNativeSandbox,
  nativeStartupTimeoutMs,
  nativeStartupCleanupConfirmed,
} from "./launch.js"
import { toDto, maxFrameBytes } from "./protocol.js"
import { NativeIngressBudget } from "./transport.js"
import { executeNativeRedis } from "./redis.js"
import { NativeAdapterHost } from "./adapter-host.js"
import { validateNativeBehaviorEvent } from "./behavior-host.js"
import { NativeMediaHost } from "./media-host.js"
import { NativeMediaSourceHost } from "./media-source-host.js"
import { snapshotNativeBot } from "./bot-snapshot.js"
import { nativeSharedWritablePaths } from "./config.js"
import { requireNativeRestartCapability } from "./core-control.js"
import { NativeBotEventsHost } from "./bot-events-host.js"
import { snapshotEvent, snapshotBotEventArguments } from "./event-snapshot.js"
import { M } from "../shared/messages.js"
export { snapshotEvent } from "./event-snapshot.js"

type Row = Record<string, unknown>
type Event = Row & { reply?: (...args: unknown[]) => unknown }
export interface NativeRequestCapabilities {
  handlerReject?: (message: string) => unknown
}

/** 校验为普通对象。 */
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(M.nativeSandbox.frame)
  return value as Row
}

export class NativePluginClient {
  readonly #settings: GuardSettings
  readonly #config: NativeSandboxPlugin
  readonly config: NativeSandboxPlugin
  private session?: Awaited<ReturnType<typeof launchNativeSandbox>>
  private readonly pending = new Map<
    string,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: NodeJS.Timeout
      startedAt: number
      mediaExtended: boolean
      type: string
      coreRestartRequested?: boolean
    }
  >()
  private readonly events = new Map<string, Event>()
  private readonly capabilities = new Map<string, NativeRequestCapabilities>()
  private readonly serviceIds = new Set<string>()
  private lastServiceId = 0
  private readyPromise?: Promise<void>
  private closed = false
  private retiring = false
  private failed?: Error
  private fatalHook = false
  private loadQueue = Promise.resolve<unknown>(undefined)
  private closePromise?: Promise<void>
  private errorLogs = 0
  private launchPromise?: ReturnType<typeof launchNativeSandbox>
  private applicationReady = false
  private handshakeReceived = false
  private transportReceived = false
  private readonly ingress = new NativeIngressBudget()
  private adapterHost?: NativeAdapterHost
  private botEventsHost?: NativeBotEventsHost
  private readonly media = new NativeMediaHost({
    isActiveRequest: id => this.pending.has(id) && typeof this.events.get(id)?.reply === "function",
  })
  private readonly mediaSource = new NativeMediaSourceHost({
    isActiveRequest: id => this.pending.get(id)?.type === "native-adapter-call",
  })
  readonly pluginRoot: string

  /** 创建原生插件沙箱客户端。 */
  constructor(
    readonly root: string,
    config: NativeSandboxPlugin,
    settings: GuardSettings,
    private readonly emit: EmitEvent,
    private readonly redis: () => unknown,
    private readonly onFailure?: (error: Error) => Promise<void>,
    private readonly onCoreRestart?: () => void,
  ) {
    this.#settings = snapshotSettings(settings)
    let configured: NativeSandboxPlugin | undefined
    arrayEach(this.#settings.pluginSandbox.native.plugins, item => {
      if (item.enabled && item.id === config.id) configured = item
    })
    if (!configured) throw new Error(M.nativeSandbox.noSession)
    this.config = this.#config = configured
    this.pluginRoot = path.join(root, "plugins", configured.id)
    const canonical = fs.realpathSync.native(this.pluginRoot)
    const ownRoot = fs.realpathSync.native(fileURLToPath(new URL("../../", import.meta.url)))
    const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)
    if (fold(canonical) !== fold(this.pluginRoot) || fold(canonical) === fold(ownRoot))
      throw new Error(M.nativeSandbox.linkedDir)
    if (!fs.statSync(canonical).isDirectory()) throw new Error(M.nativeSandbox.dirMissing)
    arrayEach(["root", "config", "pluginRoot"], key =>
      objectDefine(this, key, { configurable: false, writable: false }),
    )
  }

  /** 按规则检查沙箱请求的操作。 */
  private policy(operation: string, target: string, fallback?: "audit" | "deny" | "restart"): void {
    const event = { kind: "plugin-sandbox", plugin: this.#config.id, operation, target }
    const decision = evaluatePolicy(this.#settings, event)
    const action = decision.ruleId ? decision.action : (fallback ?? decision.action)
    this.emit({
      ...event,
      ...decision,
      action,
      details: { blocked: action !== "audit", boundary: "native-process", phase: "policy" },
    })
    if (action !== "audit") throw new GuardDeniedError(operation, decision.ruleId)
  }

  /** 以错误停止会话并拒绝在途请求。 */
  private stop(error: Error): void {
    const first = !this.failed
    if (first) this.failed = error
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    this.pending.clear()
    this.events.clear()
    this.capabilities.clear()
    this.media.close()
    this.mediaSource.close()
    if (first && this.onFailure)
      void this.onFailure(error).catch(() => {
        this.emit({
          kind: "plugin-sandbox",
          plugin: this.#config.id,
          operation: "native.registration-cleanup-unconfirmed",
          target: this.#config.id,
          action: "restart",
        })
      })
    void this.close().catch(() => {})
  }

  /** 启动沙箱子进程并等待就绪。 */
  async ready(): Promise<void> {
    if (this.closed) throw this.failed ?? new Error(M.nativeSandbox.closed)
    return (this.readyPromise ??= (async () => {
      let complete!: () => void, reject!: (error: Error) => void
      const ready = new Promise<void>((resolve, fail) => {
        complete = resolve
        reject = fail
      })
      // 立即处理拒绝，避免平台创建先失败时留下未处理拒绝。
      void ready.catch(() => {})
      const timer = setTimeout(
        () => reject(new Error(M.nativeSandbox.handshakeTimeout)),
        nativeStartupTimeoutMs,
      )
      try {
        this.launchPromise = launchNativeSandbox({
          root: this.root,
          pluginRoot: this.pluginRoot,
          entry: fileURLToPath(new URL("./child.js", import.meta.url)),
          network: this.#config.network,
          writablePaths: this.#config.writablePaths ?? [],
          writableFiles: this.#config.writableFiles ?? [],
          sharedWritablePaths: nativeSharedWritablePaths(
            this.#settings.pluginSandbox.native,
            this.#config.id,
          ),
          behavior: { pluginId: this.#config.id, settings: this.#settings },
        })
        this.session = await this.launchPromise
        if (this.closed) {
          await this.session.close()
          throw this.failed ?? new Error(M.nativeSandbox.closedStartup)
        }
        this.session.child.on("error", error => {
          reject(error)
          this.stop(error)
        })
        this.session.child.on("exit", () => {
          const error = new Error(M.nativeSandbox.exited)
          reject(error)
          if (!this.closed && !this.retiring && !this.failed) {
            const logger = Reflect.get(globalThis, "logger") as
              { error?: (message: string) => void } | undefined
            logger?.error?.(M.nativeSandbox.exitedUnexpectedly(this.#config.id))
            this.stop(error)
          }
        })
        this.session.child.on("message", (message: unknown) => {
          if (this.ingress.sealed || this.closed || this.failed) return
          try {
            const frame = object(toDto(message))
            if (Buffer.byteLength(JSON.stringify(frame)) > maxFrameBytes)
              throw new Error(M.nativeSandbox.frameLimit)
            if (frame.type === "native-ready") {
              if (!this.checkIngress(frame)) {
                reject(this.failed!)
                return
              }
              if (this.handshakeReceived) throw new Error(M.nativeSandbox.handshakeDuplicate)
              this.handshakeReceived = true
              complete()
              return
            }
            this.receive(frame)
          } catch (error) {
            reject(error as Error)
            this.stop(error as Error)
          }
        })
        await this.session.ready
        await ready
        this.applicationReady = true
        this.emit({
          kind: "plugin-sandbox",
          plugin: this.#config.id,
          operation: "native.process-started",
          target: this.session.platform === "win32" ? "appcontainer" : "bubblewrap",
          action: "audit",
          details: {
            windowsCanonical: this.session.windowsCanonicalStats?.(),
            runtime: {
              id: `native-${this.#config.id}`,
              kind: "native-scope",
              pid: this.session.child.pid,
              observability: "os-confined",
            },
          },
        })
      } catch (error) {
        this.stop(error as Error)
        throw error
      } finally {
        clearTimeout(timer)
      }
    })())
  }

  /** 向沙箱发送一帧。 */
  private send(frame: Row): void {
    if (this.closed || this.failed || !this.session?.child.connected)
      throw this.failed ?? new Error(M.nativeSandbox.disconnected)
    const dto = toDto(frame)
    if (Buffer.byteLength(JSON.stringify(dto)) > maxFrameBytes)
      throw new Error(M.nativeSandbox.frameLimit)
    this.session.child.send!(object(dto), (error: Error | null) => {
      if (error) this.stop(error)
    })
  }

  /** 处理沙箱发来的帧。 */
  private receive(frame: Row): void {
    if (!this.checkIngress(frame)) return
    if (frame.type === "preload-hello") {
      // 启动器另行确认传输；此通知不授予服务能力。
      if (
        this.transportReceived ||
        this.handshakeReceived ||
        !Number.isSafeInteger(frame.pid) ||
        Number(frame.pid) < 1
      )
        throw new Error(M.nativeSandbox.transportHandshake)
      this.transportReceived = true
    } else if (frame.type === "native-result") {
      if (typeof frame.requestId !== "string") throw new Error(M.nativeSandbox.resultIdentity)
      const item = this.pending.get(frame.requestId)
      if (!item) return
      if (typeof frame.ok !== "boolean") throw new Error(M.nativeSandbox.resultStatus)
      let failure: Error | undefined
      if (!frame.ok || this.fatalHook) {
        // 移除待处理请求前先校验；畸形错误仍须由
        // stop() 拒绝，不能留下无计时器且无法完成的宿主 Promise。
        const error = object(frame.error ?? {})
        if (
          (error.message !== undefined &&
            (typeof error.message !== "string" || error.message.length > 8000)) ||
          (error.code !== undefined && (typeof error.code !== "string" || error.code.length > 128))
        )
          throw new Error(M.nativeSandbox.errorPayload)
        failure = Object.assign(
          new Error(((error.message as string) ?? "Native request rejected").slice(0, 1000)),
          {
            code: (error.code as string) ?? "NATIVE_DENIED",
          },
        )
      }
      this.pending.delete(frame.requestId)
      this.events.delete(frame.requestId)
      this.capabilities.delete(frame.requestId)
      this.media.releaseRequest(frame.requestId)
      this.mediaSource.releaseRequest(frame.requestId)
      clearTimeout(item.timer)
      if (failure) item.reject(failure)
      else item.resolve(frame.value)
    } else if (frame.type === "native-behavior") {
      if (this.retiring) return
      const event = validateNativeBehaviorEvent(this.#settings, this.#config.id, frame.event)
      this.emit(event)
      if (event.action !== "audit") this.stop(new GuardDeniedError(event.operation, event.ruleId))
    } else if (frame.type === "native-adapter") {
      if (!this.#config.adapters || !this.adapterHost)
        throw new Error(M.nativeSandbox.adapterNotGranted)
      if (this.retiring) return
      const data = object(frame.frame)
      if (!["register", "account", "event", "remove"].includes(String(data.type)))
        throw new Error(M.nativeSandbox.adapterFrame)
      this.policy(`native.adapter.${String(data.type)}`, this.#config.id)
      this.adapterHost.receive(data)
    } else if (frame.type === "native-bot-events") {
      if (this.retiring) return
      if (!this.botEventsHost) throw new Error(M.nativeSandbox.botEventUnavailable)
      this.botEventsHost.receive(frame.frame)
    } else if (frame.type === "native-service") {
      void this.service(frame).catch(error => this.stop(error))
    } else if (frame.type === "native-hook") {
      if (typeof frame.target !== "string" || frame.target.length > 512)
        throw new Error(M.nativeSandbox.hookEvent)
      try {
        this.policy("native.hook", frame.target, this.#config.hookAction)
      } catch (error) {
        this.fatalHook = true
        this.stop(error as Error)
      }
    } else if (frame.type === "native-log") {
      // 内容可能包含用户消息或凭据，此处仅审计级别和来源。
      if (typeof frame.level !== "string") throw new Error(M.nativeSandbox.logEvent)
      if (frame.level === "error" || frame.level === "fatal") {
        this.errorLogs++
        const logger = Reflect.get(globalThis, "logger") as
          { error?: (text: string) => void } | undefined
        // 以有界文本保留插件现有的本地错误诊断，并排除于
        // 可能导出或长期保留的审计事件之外。
        const diagnostic = JSON.stringify(frame.args ?? [])
          .replace(/[\r\n\x00-\x1f\x7f]/g, " ")
          .slice(0, 2048)
        logger?.error?.(M.nativeSandbox.diagnostic(this.#config.id, frame.level, diagnostic))
      }
      this.emit({
        kind: "plugin-sandbox",
        plugin: this.#config.id,
        operation: "native.log",
        target: frame.level.slice(0, 16),
        action: "audit",
      })
    } else if (frame.type === "native-fatal") {
      const payload = object(frame.error)
      if (typeof payload.message !== "string" || typeof payload.code !== "string")
        throw new Error(M.nativeSandbox.fatalDiagnostic)
      const logger = Reflect.get(globalThis, "logger") as
        { error?: (message: string) => void } | undefined
      const message = payload.message.replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, 1000)
      logger?.error?.(M.nativeSandbox.fatal(this.#config.id, message))
      this.stop(new Error(message))
    } else throw new Error(M.nativeSandbox.frameUnknown)
  }

  /** 检查入站帧的速率与配额。 */
  private checkIngress(frame: Row): boolean {
    if (this.ingress.sealed || this.closed || this.failed) return false
    try {
      this.ingress.consume("frame")
      this.ingress.consume("bytes", Buffer.byteLength(JSON.stringify(frame)))
      if (frame.type === "native-log") {
        this.ingress.consume("log")
        if (frame.level === "error" || frame.level === "fatal") this.ingress.consume("diagnostic")
      }
      if (frame.type === "native-fatal" || (frame.type === "native-result" && frame.ok === false))
        this.ingress.consume("diagnostic")
      if (frame.type === "native-hook") this.ingress.consume("hook")
      if (frame.type === "native-adapter") this.ingress.consume("adapter")
      if (frame.type === "native-behavior") this.ingress.consume("behavior")
      if (frame.type === "native-bot-events") this.ingress.consume("bot-events")
      return true
    } catch (error) {
      this.emit({
        kind: "plugin-sandbox",
        plugin: this.#config.id,
        operation: "native.ingress-limit",
        target: this.#config.id,
        action: "deny",
        details: { blocked: true },
      })
      this.stop(error as Error)
      return false
    }
  }

  /** 消耗一次任务配额。 */
  consumeTask(): void {
    if (this.closed || this.failed || this.retiring)
      throw this.failed ?? new Error(M.nativeSandbox.notScheduling)
    try {
      this.ingress.consume("task")
    } catch (error) {
      this.emit({
        kind: "plugin-sandbox",
        plugin: this.#config.id,
        operation: "native.task-limit",
        target: this.#config.id,
        action: "deny",
        details: { blocked: true },
      })
      this.stop(error as Error)
      throw error
    }
  }

  /** 执行沙箱请求的宿主能力。 */
  private async service(frame: Row): Promise<void> {
    if (this.closed || this.failed) throw new Error(M.nativeSandbox.serviceClosed)
    if (
      typeof frame.id !== "string" ||
      !/^[1-9]\d{0,14}$/.test(frame.id) ||
      this.serviceIds.size >= 64 ||
      Number(frame.id) <= this.lastServiceId
    )
      throw new Error(M.nativeSandbox.serviceIdentity)
    this.lastServiceId = Number(frame.id)
    this.serviceIds.add(frame.id)
    try {
      if (this.retiring) throw new Error(M.nativeSandbox.serviceRevoked)
      if (typeof frame.method !== "string" || !Array.isArray(frame.args))
        throw new Error(M.nativeSandbox.serviceArgs)
      const args = frame.args
      const policyTarget =
        frame.service === "core" && frame.method === "restart" ? "controlled-core" : frame.method
      this.policy(`native.${String(frame.service)}.${frame.method}`, policyTarget)
      let value: unknown
      let restart = false
      if (frame.service === "event" && frame.method === "reply") {
        const event =
          typeof frame.requestId === "string" ? this.events.get(frame.requestId) : undefined
        if (!event?.reply || args.length > 3) throw new Error(M.nativeSandbox.eventCapability)
        const reply = this.media.consumeReply(frame.requestId, args)
        try {
          value = await Reflect.apply(event.reply, event, reply)
        } finally {
          this.media.releaseReply(reply)
        }
      } else if (frame.service === "media") {
        value = this.media.receive(frame.requestId, frame.method, args)
        if (frame.method === "open") this.extendMediaRequest(frame.requestId)
      } else if (frame.service === "media-source") {
        value = this.mediaSource.receive(frame.requestId, frame.method, args)
      } else if (frame.service === "event" && frame.method === "handlerReject") {
        const reject =
          typeof frame.requestId === "string"
            ? this.capabilities.get(frame.requestId)?.handlerReject
            : undefined
        if (!reject || args.length !== 1 || typeof args[0] !== "string" || args[0].length > 2048)
          throw new Error(M.nativeSandbox.rejectCapability)
        value = await reject(args[0])
      } else if (frame.service === "redis") {
        value = await executeNativeRedis(this.redis(), this.#config.redis, frame.method, args)
      } else if (frame.service === "core" && frame.method === "restart") {
        const pending =
          typeof frame.requestId === "string" ? this.pending.get(frame.requestId) : undefined
        const event =
          typeof frame.requestId === "string" ? this.events.get(frame.requestId) : undefined
        requireNativeRestartCapability(
          args,
          pending?.type,
          event,
          pending?.coreRestartRequested === true,
          this.#config.allowCoreRestart === true,
        )
        if (!this.onCoreRestart) throw new Error(M.nativeSandbox.restartUnavailable)
        pending!.coreRestartRequested = true
        restart = true
        value = true
      } else throw new Error(M.nativeSandbox.serviceUnknown)
      this.send({ type: "native-service-result", id: frame.id, ok: true, value: toDto(value) })
      if (restart) {
        this.emit({
          kind: "plugin-sandbox",
          plugin: this.#config.id,
          operation: "native.core.restart",
          target: "controlled-core",
          action: "audit",
        })
        this.onCoreRestart!()
      }
    } catch (error) {
      // 规则审计只记录尝试，不代表服务执行成功；保留最终错误，
      // 但不保留 Redis 键、媒体路径或 SDK 消息。
      let code: unknown
      try {
        const descriptor =
          error && typeof error === "object"
            ? Object.getOwnPropertyDescriptor(error, "code")
            : undefined
        if (descriptor && "value" in descriptor) code = descriptor.value
      } catch {
        /* 诊断不得执行或依赖 SDK 自定义访问器。 */
      }
      this.emit({
        kind: "plugin-sandbox",
        plugin: this.#config.id,
        operation: "native.service-error",
        target: `${typeof frame.service === "string" ? frame.service.slice(0, 32) : "unknown"}.${typeof frame.method === "string" ? frame.method.slice(0, 64) : "unknown"}`,
        action: "audit",
        details: {
          phase: "result",
          result: "error",
          code:
            typeof code === "string" &&
            /^(?:NATIVE_(?:REDIS|CORE)_DENIED|GUARD_DENIED|MEDIA_[A-Z_]{1,40})$/.test(code)
              ? code
              : "SERVICE_ERROR",
        },
      })
      if (!this.closed)
        this.send({
          type: "native-service-result",
          id: frame.id,
          ok: false,
          error: { code: "SERVICE_DENIED", message: (error as Error).message.slice(0, 1000) },
        })
    } finally {
      this.serviceIds.delete(frame.id)
    }
  }

  /** 有界传输仅允许一次固定延期，分片不能使请求无限存活。 */
  private extendMediaRequest(requestId: unknown): void {
    if (typeof requestId !== "string") return
    const item = this.pending.get(requestId)
    if (!item || item.mediaExtended) return
    item.mediaExtended = true
    clearTimeout(item.timer)
    item.timer = setTimeout(
      () => this.stop(new Error(M.nativeSandbox.mediaTimeout(item.type))),
      // 回复可先上传 16 MiB，再流式传入独立原生适配器。
      Math.max(1, item.startedAt + 90000 - performance.now()),
    )
  }

  /** 向沙箱发起请求并等待结果。 */
  async request(
    type: string,
    values: Row,
    event?: Event,
    capabilities?: NativeRequestCapabilities,
  ): Promise<unknown> {
    if (this.retiring && type !== "native-dispose") throw new Error(M.nativeSandbox.retiring)
    await this.ready()
    if (this.retiring && type !== "native-dispose") throw new Error(M.nativeSandbox.retiring)
    if (this.pending.size >= 64) throw new Error(M.nativeSandbox.requestLimit)
    if (type !== "native-release-instances")
      this.policy(
        type.replace("native-", "native."),
        String(values.classId ?? values.entry ?? this.#config.id),
      )
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.stop(new Error(M.nativeSandbox.requestTimeout(type))),
        this.#config.timeoutMs,
      )
      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        startedAt: performance.now(),
        mediaExtended: false,
        type,
      })
      if (event) this.events.set(requestId, event)
      if (capabilities) this.capabilities.set(requestId, capabilities)
      try {
        if (type === "native-adapter-call") {
          const call = object(values.call)
          const sources = this.mediaSource.stats.requests
          this.mediaSource.bindRequest(requestId, call.args)
          if (this.mediaSource.stats.requests > sources) this.extendMediaRequest(requestId)
        }
        this.send({
          type,
          requestId,
          ...values,
          ...(type === "native-dispose"
            ? {}
            : { botState: snapshotNativeBot(Reflect.get(globalThis, "Bot")) }),
          ...(event && type !== "native-bot-event"
            ? { event: snapshotEvent(event, this.protectedBotObjects()) }
            : {}),
        })
      } catch (error) {
        clearTimeout(this.pending.get(requestId)?.timer ?? timer)
        this.pending.delete(requestId)
        this.events.delete(requestId)
        this.capabilities.delete(requestId)
        this.media.releaseRequest(requestId)
        this.mediaSource.releaseRequest(requestId)
        reject(error)
      }
    })
  }

  /** 释放沙箱中的实例。 */
  async releaseInstances(instances: Array<{ classId: string; instanceId: string }>): Promise<void> {
    if (this.failed || this.retiring || this.closed) {
      await this.close()
      return
    }
    try {
      await this.request("native-release-instances", { instances })
    } catch (error) {
      // 违规插件已经退役时，以系统范围退出确认为准。
      if (this.failed || this.retiring || this.closed) await this.close()
      else throw error
    }
  }

  /** 在沙箱中加载插件入口。 */
  load(entry: string): Promise<NativeLoadResult> {
    const operation = this.loadQueue.then(async () => {
      this.initializeBotEvents()
      if (this.#config.adapters && !this.adapterHost)
        this.adapterHost = new NativeAdapterHost({
          pluginId: this.#config.id,
          bot: object(Reflect.get(globalThis, "Bot")),
          invoke: call => this.request("native-adapter-call", { call }),
          serializeArgs: args => this.mediaSource.serializeArgs(args),
          discardArgs: args => this.mediaSource.discardArgs(args),
        })
      const errors = this.errorLogs
      const value = await this.request("native-load", {
        root: this.root,
        pluginRoot: this.pluginRoot,
        entry,
        hookAction: this.#config.hookAction,
        adapters: this.#config.adapters === true,
        ...(this.botEventsHost ? { botEventsSessionId: this.botEventsHost.sessionId } : {}),
      })
      if (this.errorLogs !== errors) throw new Error(M.nativeSandbox.importErrors(this.#config.id))
      return value
    })
    this.loadQueue = operation.catch(() => {})
    return operation.then(value => {
      const row = object(value)
      if (!Array.isArray(row.classes) || row.classes.length > 256)
        throw new Error(M.nativeSandbox.classList)
      return row as unknown as NativeLoadResult
    })
  }

  /** 建立 Bot 事件代理。 */
  private initializeBotEvents(): void {
    if (this.botEventsHost) return
    const bot = Reflect.get(globalThis, "Bot")
    if (!bot || typeof bot !== "object") return
    const emitter = Reflect.get(bot, "bot") ?? bot
    if (!emitter || typeof emitter !== "object") return
    const names = ["on", "off", "eventNames", "listeners"] as const
    const methods = names.map(name => {
      const method = Reflect.get(emitter, name)
      return typeof method === "function" ? method.bind(emitter) : undefined
    })
    if (methods.some(method => typeof method !== "function")) return
    const [on, off, eventNames, listeners] = methods
    this.botEventsHost = new NativeBotEventsHost({
      emitter: { key: emitter, on, off, eventNames, listeners },
      policy: event => this.policy("native.bot.on", event),
      serializeArgs: (args, event) =>
        snapshotBotEventArguments(args, event, {
          protectedObjects: this.protectedBotObjects(),
          botState: snapshotNativeBot(bot),
        }),
      invoke: (handle, args, originalEvent) => {
        const event =
          originalEvent && !this.protectedBotObjects().has(originalEvent)
            ? originalEvent
            : undefined
        const reply = event && Object.getOwnPropertyDescriptor(event, "reply")
        return this.request(
          "native-bot-event",
          {
            handle,
            args,
            eventReply: !!reply && "value" in reply && typeof reply.value === "function",
          },
          event,
        )
      },
      onFailure: failure => {
        if (failure.kind === "cleanup") {
          this.emit({
            kind: "plugin-sandbox",
            plugin: this.#config.id,
            operation: "native.registration-cleanup-unconfirmed",
            target: this.#config.id,
            action: "restart",
          })
          if (!this.retiring) this.stop(new Error(M.nativeSandbox.botListenerCleanup))
          return
        }
        this.emit({
          kind: "plugin-sandbox",
          plugin: this.#config.id,
          operation: "native.bot.delivery-error",
          target: failure.event,
          action: "audit",
          details: { phase: "result", result: "error" },
        })
      },
    })
  }

  /** 收集不能交给沙箱的受保护 Bot 对象。 */
  private protectedBotObjects(): Set<object> {
    const values = new Set<object>()
    const bot = Reflect.get(globalThis, "Bot")
    if (!bot || typeof bot !== "object") return values
    values.add(bot)
    const emitter = Reflect.get(bot, "bot") ?? bot
    if (!emitter || typeof emitter !== "object") return values
    values.add(emitter)
    const descriptor = Object.getOwnPropertyDescriptor(emitter, "bots")
    const accounts = descriptor && "value" in descriptor ? descriptor.value : undefined
    if (accounts && typeof accounts === "object") {
      values.add(accounts)
      for (const entry of Object.values(Object.getOwnPropertyDescriptors(accounts)))
        if ("value" in entry && entry.value && typeof entry.value === "object")
          values.add(entry.value)
    }
    return values
  }

  /** 关闭会话并结束子进程。 */
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    return (this.closePromise = (async () => {
      this.retiring = true
      this.events.clear()
      this.capabilities.clear()
      this.media.close()
      this.mediaSource.close()
      let adapterFailure: Error | undefined
      let botEventsFailure: Error | undefined
      try {
        this.botEventsHost?.close()
      } catch (error) {
        botEventsFailure = error as Error
        this.emit({
          kind: "plugin-sandbox",
          plugin: this.#config.id,
          operation: "native.registration-cleanup-unconfirmed",
          target: this.#config.id,
          action: "restart",
        })
      }
      try {
        this.adapterHost?.close()
      } catch (error) {
        adapterFailure = error as Error
        this.emit({
          kind: "plugin-sandbox",
          plugin: this.#config.id,
          operation: "native.adapter-cleanup-unconfirmed",
          target: this.#config.id,
          action: "restart",
        })
      }
      try {
        if (this.applicationReady && !this.failed) {
          try {
            const disposal = object(await this.request("native-dispose", {}))
            if (disposal.failed)
              this.emit({
                kind: "plugin-sandbox",
                plugin: this.#config.id,
                operation: "native.dispose-errors",
                target: this.#config.id,
                action: "audit",
              })
          } catch {
            /* 插件清理失败也必须回收系统范围。 */
          }
        }
        this.closed = true
        for (const item of this.pending.values()) {
          clearTimeout(item.timer)
          item.reject(this.failed ?? new Error(M.nativeSandbox.pendingCancelled))
        }
        this.pending.clear()
        this.events.clear()
        // 异步平台启动可能在超时或关闭请求之后才完成。
        if (!this.session && this.launchPromise) {
          try {
            this.session = await this.launchPromise
          } catch (error) {
            if (!nativeStartupCleanupConfirmed(error)) throw error
          }
        }
        await this.session?.close()
        if (this.session)
          this.emit({
            kind: "plugin-sandbox",
            plugin: this.#config.id,
            operation: "native.process-closed",
            target: this.session.platform === "win32" ? "appcontainer" : "bubblewrap",
            action: "audit",
            details: {
              confirmed: true,
              windowsCanonical: this.session.windowsCanonicalStats?.(),
            },
          })
      } catch (error) {
        this.emit({
          kind: "plugin-sandbox",
          plugin: this.#config.id,
          operation: "native.cleanup-unconfirmed",
          target: this.#config.id,
          action: "restart",
          details: { windowsCanonical: this.session?.windowsCanonicalStats?.() },
        })
        throw error
      }
      if (adapterFailure) throw adapterFailure
      if (botEventsFailure) throw botEventsFailure
    })())
  }
}
