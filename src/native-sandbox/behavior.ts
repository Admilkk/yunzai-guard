import { isMainThread } from "node:worker_threads"
import { parseSettings } from "../config/index.js"
import { number, string } from "../config/validation.js"
import { installRuntime } from "../runtime/index.js"
import { runtimeKey, type RuntimeIdentity } from "../runtime/worker-monitor.js"
import type { EmitEvent, GuardSettings } from "../shared/types.js"
import { parseNativeSandbox } from "./config.js"
import { M } from "../shared/messages.js"

export interface NativeBehaviorOptions {
  pluginId: string
  identity: { id: string; generation: number; parentId?: string }
  settings: unknown
  /** 沿用原生会话传输；父进程须核验身份并重新判定规则。 */
  emit: EmitEvent
  /** 可信只读别名清单，与运行时 broker 凭据分离。 */
  resolutionManifestPath?: string
}

export interface NativeBehaviorHandle {
  readonly identity: RuntimeIdentity
  readonly settings: GuardSettings
  readonly ready: Promise<void>
  /** 仅恢复本地包装，系统会话生命周期仍由所有者负责。 */
  dispose(): void
}

/** 仅复制共用行为规则；原生插件进程不持有真实 Bot 及其目标对象。 */
export function nativeBehaviorSettings(value: unknown): GuardSettings {
  const settings = parseSettings(value)
  return parseSettings({
    rules: settings.rules,
    audit: settings.audit,
    handshakeTimeout: settings.handshakeTimeout,
    protect: { ...settings.protect, targets: [] },
  })
}

/**
 * 在已建立的系统隔离内安装，早于任何业务源码导入。
 * 此处仅观察 JS 入口，不能防护同进程的任意代码。
 * Worker 继承私有端口监控，其他子进程仅保留系统限制和
 * 进程创建审计；本组件不使用运行时 broker 清单或 socket。
 */
export function installNativeBehavior(options: NativeBehaviorOptions): NativeBehaviorHandle {
  if (!isMainThread) throw new Error(M.nativeSandbox.behaviorThread)
  if (Object.hasOwn(globalThis, runtimeKey)) throw new Error(M.nativeSandbox.behaviorInstalled)
  const pluginId = parseNativeSandbox({ plugins: [{ id: options.pluginId }] }).plugins[0].id
  const settings = nativeBehaviorSettings(options.settings)
  const identity: RuntimeIdentity = Object.freeze({
    id: string(options.identity.id, "nativeBehavior.identity.id", 128),
    ...(options.identity.parentId === undefined
      ? {}
      : { parentId: string(options.identity.parentId, "nativeBehavior.identity.parentId", 128) }),
    generation: number(
      options.identity.generation,
      1,
      "nativeBehavior.identity.generation",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    kind: "node-process",
    pid: process.pid,
    originPlugin: pluginId,
    observability: "js-entrypoints",
  })
  if (typeof options.emit !== "function") throw new TypeError(M.nativeSandbox.behaviorEmitter)
  let disposed = false
  const emit = options.emit
  const runtime = installRuntime({
    identity,
    settings,
    contextProvider: () => pluginId,
    resolutionManifestPath: options.resolutionManifestPath,
    // 有意省略：原生别名清单不能作为运行时 broker 凭据。
    /** 转发事件并归因到当前插件。 */
    emit(event) {
      if (!disposed) emit({ ...event, plugin: pluginId })
    },
  })
  return Object.freeze({
    identity: runtime.identity,
    settings,
    ready: runtime.ready,
    /** 停用行为监控。 */
    dispose() {
      if (disposed) return
      disposed = true
      runtime.instrumentation()
    },
  })
}
