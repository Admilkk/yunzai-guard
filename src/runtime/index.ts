import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { syncBuiltinESMExports } from "node:module"
import workerThreads from "node:worker_threads"
import { randomUUID } from "node:crypto"
import {
  getEnvironmentData,
  isMainThread,
  MessagePort,
  setEnvironmentData,
  threadId,
} from "node:worker_threads"
import { parseSettings } from "../config/index.js"
import { installInstrumentation, type InstrumentationDisposer } from "../instrumentation/index.js"
import { IntegrityMonitor } from "../monitor/integrity.js"
import { installSandboxResolution } from "../sandbox/resolution.js"
import {
  installWorkerMonitor,
  runtimeKey,
  workerMetadataKey,
  type RuntimeIdentity,
} from "./worker-monitor.js"
import type { EmitEvent, GuardSettings } from "../shared/types.js"
import { auditProtocol } from "../audit/protocol.js"
import type { WorkerAuditCloseOptions, WorkerAuditCoverage } from "./worker-monitor.js"
import type { RuntimeManifest } from "./protocol.js"
import { attach, reportFailure, type Lifecycle } from "./reporter.js"
import { connectPort } from "./port.js"
import { connectSocket } from "./socket.js"
import { installHookWatch, type HookWatch } from "../monitor/watch.js"
import { installFileGuard } from "../protect/files.js"
import { protectObjects, seal, refuse, freezeData } from "../protect/objects.js"
import { installDebugGuard } from "../protect/debug.js"
import { installBindingGuard } from "../protect/bindings.js"
import { installReportGuard } from "../protect/reports.js"
import { installSqliteGuard } from "../protect/sqlite.js"
import { M } from "../shared/messages.js"

export interface RuntimeHandle {
  identity: RuntimeIdentity
  ready: Promise<void>
  instrumentation: InstrumentationDisposer
  watch: HookWatch
  prepareAudit(options: WorkerAuditCloseOptions): void
  auditCoverage(): WorkerAuditCoverage
}
interface RuntimeOptions {
  settings: GuardSettings
  identity: RuntimeIdentity
  manifestPath?: string
  /** 仅用于模块解析；此文件不授权连接运行时代理。 */
  resolutionManifestPath?: string
  emit: EmitEvent
  ready?: Promise<void>
  contextProvider?: () => string | undefined
}

let installedRuntime: RuntimeHandle | undefined
const lifecycle: Lifecycle = {
  prepare: options => installedRuntime?.prepareAudit(options),
  coverage: () => installedRuntime?.auditCoverage().nestedCoverage ?? "unknown",
  dispose: () => installedRuntime?.instrumentation(),
}

/** 读取并校验运行时清单。 */
function readManifest(filename: string): RuntimeManifest {
  const bytes = fs.readFileSync(filename)
  if (bytes.length > 8 * 1024 * 1024) throw new Error(M.runtime.manifestTooLarge)
  const input = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as RuntimeManifest
  if (
    !input ||
    input.version !== 1 ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    typeof input.projectId !== "string" ||
    typeof input.endpoint !== "string" ||
    !input.endpoint.length ||
    typeof input.token !== "string" ||
    input.token.length < 16
  )
    throw new Error(M.runtime.manifest)
  return { ...input, settings: parseSettings(input.settings) }
}

/** 共用的同步安装入口，可安全地由 runtime-bootstrap.cjs require。 */
export function installRuntime(options: RuntimeOptions): RuntimeHandle {
  if (installedRuntime) refuse("runtime-reinstall", "guard-runtime")
  freezeData(options.settings)
  const identity = Object.freeze({ ...options.identity })
  const emit: EmitEvent = event => options.emit(attach(event, identity))
  const originPlugin = () =>
    options.contextProvider?.() ??
    (identity.originPlugin === "unknown" ? undefined : identity.originPlugin)
  const watch = installHookWatch()
  protectObjects(emit, originPlugin, watch)
  const sealApi = (object: object, key: PropertyKey, value: unknown, label?: string) =>
    seal(object, key, value, label ?? String(key), true)
  for (const item of watch.targets())
    sealApi(item.object, item.key, item.value, `hook-watch.${item.key}`)
  installDebugGuard(sealApi, refuse)
  installBindingGuard(sealApi, refuse)
  const roots = [
    fileURLToPath(new URL("../../", import.meta.url)),
    path.join(process.cwd(), "data/yunzai-guard"),
    ...[options.manifestPath, options.resolutionManifestPath].filter((file): file is string =>
      Boolean(file),
    ),
  ]
  installReportGuard({ roots, deny: refuse, seal: sealApi })
  const readRoots = [
    path.join(process.cwd(), "data/yunzai-guard"),
    ...[options.manifestPath, options.resolutionManifestPath].filter((file): file is string =>
      Boolean(file),
    ),
  ]
  // fs 收口先于行为监控安装，业务文件观察在监控就绪后再接入。
  let observeFile: InstrumentationDisposer["observeFile"] | undefined
  installFileGuard({
    roots,
    readRoots,
    deny: refuse,
    seal: sealApi,
    observe: (operation, target, write, source) => observeFile?.(operation, target, write, source),
  })
  installSqliteGuard({ roots, readRoots, deny: refuse, seal: sealApi, emit })
  const instrumentation = installInstrumentation(options.settings, emit, originPlugin, {
    manifestPath: options.manifestPath,
    resolutionManifestPath: options.resolutionManifestPath,
    runtimeId: identity.id,
    originPlugin,
  })
  instrumentation.protect(sealApi)
  observeFile = instrumentation.observeFile
  const stopWorkers = installWorkerMonitor({ ...options, identity, emit, originPlugin })
  sealApi(workerThreads, "Worker", workerThreads.Worker, "worker_threads.Worker")
  sealApi(workerThreads.Worker.prototype, "constructor", workerThreads.Worker, "Worker.constructor")
  const getData = workerThreads.getEnvironmentData
  const setData = workerThreads.setEnvironmentData
  sealApi(
    workerThreads,
    "getEnvironmentData",
    (key: unknown) =>
      key === workerMetadataKey ? undefined : getData(key as Parameters<typeof getData>[0]),
    "Worker.getEnvironmentData",
  )
  sealApi(
    workerThreads,
    "setEnvironmentData",
    (key: unknown, value: unknown) => {
      if (key === workerMetadataKey) refuse("worker-metadata", workerMetadataKey)
      return setData(key as Parameters<typeof setData>[0], value as Parameters<typeof setData>[1])
    },
    "Worker.setEnvironmentData",
  )
  syncBuiltinESMExports()
  let monitor: IntegrityMonitor | undefined
  const dispose = Object.assign(
    () => {
      monitor?.stop()
      stopWorkers()
      instrumentation()
    },
    {
      targets: instrumentation.targets,
      observeFile: instrumentation.observeFile,
      checkIntegrity: instrumentation.checkIntegrity,
      protect: instrumentation.protect,
    },
  )
  Object.defineProperty(globalThis, runtimeKey, {
    value: Object.freeze({ identity, settings: options.settings }),
  })
  const handle: RuntimeHandle = {
    identity,
    watch,
    instrumentation: dispose,
    ready: options.ready ?? Promise.resolve(),
    prepareAudit: close => stopWorkers.prepareAudit(close),
    auditCoverage: () => stopWorkers.auditCoverage(),
  }
  installedRuntime = Object.freeze(handle)
  if (identity.kind !== "yunzai" && options.settings.protect.targets.length) {
    monitor = new IntegrityMonitor(
      options.settings,
      () => ({ ...instrumentation.targets(), Global: globalThis }),
      emit,
      watch,
    )
    monitor.start()
  }
  return handle
}

/** 由 Node 子进程和 Worker 线程的同步预加载器调用。 */
export function installInheritedRuntime(): Pick<RuntimeHandle, "identity" | "ready"> | undefined {
  const readonly = (runtime: RuntimeHandle) =>
    Object.freeze({ identity: runtime.identity, ready: runtime.ready })
  if (installedRuntime) return readonly(installedRuntime)
  if (!isMainThread) {
    const metadata = getEnvironmentData(workerMetadataKey) as
      | {
          version?: unknown
          identity: RuntimeIdentity
          settings: unknown
          manifestPath?: string
          resolutionManifestPath?: string
          port?: MessagePort
          auditChannelNonce?: string
        }
      | undefined
    if (!metadata) throw new Error(M.runtime.workerMetadataMissing)
    setEnvironmentData(workerMetadataKey, undefined)
    if (
      metadata.version !== 1 ||
      !(metadata.port instanceof MessagePort) ||
      !metadata.identity?.id ||
      typeof metadata.auditChannelNonce !== "string" ||
      !/^[a-f0-9]{48}$/.test(metadata.auditChannelNonce)
    )
      throw new Error(M.runtime.workerMetadata)
    installSandboxResolution(metadata.resolutionManifestPath ?? metadata.manifestPath)
    const settings = parseSettings(metadata.settings)
    const identity: RuntimeIdentity = {
      ...metadata.identity,
      kind: "thread",
      pid: process.pid,
      threadId,
    }
    const transport = connectPort(
      metadata.port,
      settings,
      identity,
      metadata.auditChannelNonce,
      lifecycle,
    )
    const handle = installRuntime({
      settings,
      identity,
      manifestPath: metadata.manifestPath,
      resolutionManifestPath: metadata.resolutionManifestPath,
      emit: transport,
    })
    try {
      metadata.port.postMessage({
        type: "runtime-ready",
        auditProtocol,
        generation: identity.generation,
        channelNonce: metadata.auditChannelNonce,
      })
    } catch {
      reportFailure(settings, identity, "worker-ready-delivery-failed")
    }
    return readonly(handle)
  }
  const filename = process.env.YUNZAI_GUARD_RUNTIME_MANIFEST
  if (!filename) return undefined
  installSandboxResolution(filename)
  const manifest = readManifest(filename)
  const identity: RuntimeIdentity = {
    id: randomUUID(),
    parentId: process.env.YUNZAI_GUARD_PARENT_RUNTIME,
    originPlugin: (process.env.YUNZAI_GUARD_ORIGIN_PLUGIN ?? "unknown")
      .replace(/[\r\n\0]/g, "")
      .slice(0, 128),
    generation: manifest.generation,
    kind: "node-process",
    pid: process.pid,
    observability: "js-entrypoints",
  }
  const transport = connectSocket(manifest, identity, lifecycle)
  return readonly(
    installRuntime({
      settings: manifest.settings,
      identity,
      manifestPath: filename,
      emit: transport.emit,
      ready: transport.ready,
    }),
  )
}
