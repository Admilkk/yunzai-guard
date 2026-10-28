import fs from "node:fs"
import path from "node:path"
import net from "node:net"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { randomBytes } from "node:crypto"
import { sanitizeAuditEvent } from "../audit/event.js"
import { redactAuditText as redact } from "../audit/redaction.js"
import { SqliteAuditSink } from "../audit/store.js"
import { AuditBuffer, type AuditClosePermit } from "../audit/buffer.js"
import { AuditReceiver } from "../audit/receiver.js"
import { sandboxEngineLabel } from "../plugin-sandbox/engine.js"
import { createControlServer } from "./control-server.js"
import { readRecoveryState, saveRecoveryState } from "./recovery.js"
import { auditCoverageRecords, type AuditCoverageStage } from "../audit/coverage.js"
import { createAuditDeadline, type AuditDeadline } from "../audit/protocol.js"
import { RuntimeBroker } from "../runtime/broker.js"
import { assertOriginalWindowsChildProbeRuntime } from "../native-process/index.js"
import { prepareDependencies } from "../dependencies/check.js"
import { createControlVerifier, isControlType } from "../runtime/control.js"
import { assertNoDebugger } from "../protect/debug.js"
import { assertNoInternals } from "../protect/bindings.js"
import { authorizeHostEvent } from "./event-policy.js"
import { waitForBootstrapHandoff } from "./bootstrap/handoff.js"
import { installHostLog, pipeHostOutput, pruneHostLog } from "./log.js"
import { loadSandboxSources } from "../plugin-sandbox/filesystem.js"
import { monitorStatus, parseMonitorReport, type MonitorReport } from "../monitor/report.js"
import { buildLinuxSandbox } from "../sandbox/linux.js"
import {
  spawnWindowsSandbox,
  type WindowsSandboxProcess,
  type WindowsSandboxTransportCounters,
  type WindowsCanonicalStats,
} from "../sandbox/windows.js"
import { acquireProjectLock, legacyProjectPort, type ProjectLock } from "./lock.js"
import { startPanel, stopPanel } from "../web/index.js"
import { SettingsController } from "./settings.js"
import type { GuardSettings } from "../shared/types.js"
import {
  root,
  settings as initialSettings,
  projectId,
  controlPort as requestedControlPort,
  controlPath,
  stateDir,
  until,
  sleep,
} from "./context.js"
import {
  assertPlatform,
  capabilities,
  captureDescendants,
  prepareDescendantCapture,
  retireDescendantCapture,
  hasExited,
  terminateWorkerTree,
  type ProcessIdentity,
} from "./platform.js"
import { UsageWatch } from "./usage.js"
import { UpdateService } from "./update.js"
import { AlertService } from "./alerts.js"
import { SourceWatch } from "./sources.js"
import { atLeast, BehaviorProfile, type Anomaly, type ProfileEvent } from "./profile.js"
import { parseSettings } from "../config/index.js"
import type { StagedRelease } from "../update/install.js"
import { M } from "../shared/messages.js"

type Phase = "handoff" | "starting" | "online" | "restarting" | "backoff" | "tripped" | "stopping"
type Action = {
  type: "start" | "restart" | "stop" | "resume" | "recover" | "configure" | "update"
  reason?: string
  staged?: StagedRelease
  from?: string
  rollback?: boolean
}
interface Session {
  settings: GuardSettings
  sandboxSources: ReturnType<typeof loadSandboxSources>
  child: ChildProcess
  generation: number
  online: boolean
  handshaken: boolean
  preloaded: boolean
  expectedExit: boolean
  failure?: string
  descendants: ProcessIdentity[]
  broker: RuntimeBroker
  reportedPid?: number
  dispose?: () => void | Promise<void>
  waitScopeExit?: () => Promise<void>
  waitOutput?: (timeout: number) => Promise<void>
  monitor?: { report: MonitorReport; receivedAt: number }
  audit: AuditReceiver
  auditChannelNonce: string
  controlKey: string
  verifyControl?: (frame: unknown) => boolean
  closeAudit?: { nonce: string; deadline: AuditDeadline }
  cleanupError?: string
  windowsTransportStats?: () => WindowsSandboxTransportCounters
  windowsCanonicalStats?: () => WindowsCanonicalStats
  usage?: UsageWatch
}

let settings = initialSettings
installHostLog(stateDir, { maxBytes: settings.log.maxBytes })
assertPlatform(settings.isolationMode)
assertNoDebugger()
assertNoInternals()
await prepareDependencies(settings)
let sandboxSources = loadSandboxSources(root, settings.pluginSandbox)
// app.js 可接收数字业务参数；仅直接运行 supervisor 入口时解析交接 PID。
const bootstrapPid =
  path.basename(process.argv[1] || "") === "supervisor.js"
    ? Number(process.argv[2]) || undefined
    : undefined
const supervisedIpc = Boolean(process.connected && !bootstrapPid)
const bootstrapRedisPid = bootstrapPid
  ? process.argv[3] === "none"
    ? null
    : Number(process.argv[3])
  : null
const bootstrapAbort = new AbortController()
let bootstrapHandoff: Promise<unknown> | undefined
let bootstrapPending = Boolean(bootstrapPid)
const token = randomBytes(24).toString("hex")
const projectLockPort = legacyProjectPort(projectId)
let projectLock: ProjectLock | undefined
let controlPort = requestedControlPort
const recoveryPath = path.join(stateDir, "recovery.json")
let worker: Session | undefined
let generation = 0
let phase: Phase = "handoff"
let stopping = false
let pending: Action | undefined
let active: Action | undefined
let pumping = false
let logAvailable = true
let invalidMessages = 0
/** 由 node . start 原地切换而来：外部管理器（Docker、node . daemon）负责拉起，主动停止返回 255 表示不要再拉起。 */
const external = process.env.YUNZAI_GUARD_EXTERNAL === "1"
let exitCode = external ? 255 : 0
let lastAudit: ReturnType<AuditReceiver["stats"]> | undefined
let lastAuditPermit: AuditClosePermit | undefined
let lastWindowsTransport: WindowsSandboxTransportCounters | undefined
let lastWindowsCanonical: WindowsCanonicalStats | undefined
let lastBrokerTransport: ReturnType<RuntimeBroker["transportStats"]> | undefined
let auditSink: SqliteAuditSink
let relaunch = false
const auditBuffer = new AuditBuffer({
  sink: { appendBatch: frames => auditSink.appendBatch(frames) },
  maxEventsPerSecond: settings.audit.maxEventsPerSecond,
  maxBytes: settings.audit.maxBytes,
})
const configuration = new SettingsController(settings, {
  /** 预检候选配置所需的平台与依赖。 */
  async prepare(candidate) {
    assertPlatform(candidate.isolationMode)
    await prepareDependencies(candidate)
    return loadSandboxSources(root, candidate.pluginSandbox)
  },
  /** 直接应用无需重建业务进程的字段。 */
  applyLive(next) {
    if (stopping) throw new Error(M.host.stopping)
    auditSink.updateLimits(next.audit)
    auditBuffer.updateLimits(next.audit)
    settings = next
    pruneLogs()
  },
  /** 以候选配置重建业务进程。 */
  async reload(candidate, sources) {
    if (stopping) throw new Error(M.host.stopping)
    if (recovery.tripped) throw new Error(M.host.tripped)
    const previous = settings
    const previousSources = sandboxSources
    try {
      await stopWorker()
    } catch (error) {
      trip(`configuration-cleanup-unconfirmed:${(error as Error).message}`)
      throw error
    }
    if (stopping) throw new Error(M.host.stopping)
    settings = candidate
    sandboxSources = sources
    try {
      await startWorker()
      if (!worker?.online || worker.failure || stopping)
        throw new Error(worker?.failure || M.host.workerNotReady)
    } catch (error) {
      settings = previous
      sandboxSources = previousSources
      if (stopping) throw error
      try {
        await stopWorker()
      } catch (cleanupError) {
        trip(`configuration-cleanup-unconfirmed:${(cleanupError as Error).message}`)
        throw new AggregateError([error, cleanupError], M.host.rollbackFailed)
      }
      try {
        await startWorker()
        if (!worker?.online || worker.failure)
          throw new Error(worker?.failure || M.host.previousWorkerNotReady)
      } catch (rollbackError) {
        await stopWorker().catch(cleanupError => {
          record("configuration-cleanup-error", { message: (cleanupError as Error).message })
        })
        trip(`configuration-rollback-failed:${(rollbackError as Error).message}`)
        throw new AggregateError([error, rollbackError], M.host.rollbackFailed)
      }
      throw error
    }
  },
})

/** 递归清洗宿主记录的数据，限制深度与长度。 */
function sanitized(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth limit]"
  if (typeof value === "string") return redact(value)
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "boolean" || value === null || value === undefined) return value
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitized(item, depth + 1))
  if (typeof value !== "object") return "[unsupported]"
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    result[key.slice(0, 80)] =
      /token|password|passwd|secret|authorization|cookie|args|environment|headers/i.test(key)
        ? "[redacted]"
        : sanitized(item, depth + 1)
  }
  return result
}

/** 记录一条宿主事件。 */
function record(type: string, details: Record<string, unknown> = {}): void {
  auditSink.record(type, sanitized(details) as Record<string, unknown>)
  const available = auditSink.stats().available
  if (!available && logAvailable) console.error(M.host.auditWriteFailed)
  logAvailable = available
}

/** 记录本代次的审计覆盖汇总。 */
function recordAuditCoverage(stage: AuditCoverageStage): void {
  if (lastAudit)
    for (const row of auditCoverageRecords(lastAudit, stage)) record(row.type, row.details)
}

// 宿主是最后一道守护：未捕获异常必须留下记录，不能让进程静默消失。
let hostReady = false
let handlingHostFailure = false
/** 处理宿主内部故障：记录并安全停止。 */
function handleHostFailure(label: string, error: unknown): void {
  if (handlingHostFailure) return
  handlingHostFailure = true
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  try {
    record(`host-${label}`, { message: reason })
  } catch {}
  try {
    console.error(M.host.event(label, reason))
  } catch {}
  if (!hostReady) process.exit(1)
  exitCode = 1
  // 清理失败时沿用熔断与持锁流程，不能释放仍有存活业务的项目锁。
  enqueue({ type: "stop" })
}
for (const [event, label] of [
  ["uncaughtException", "uncaught-exception"],
  ["unhandledRejection", "unhandled-rejection"],
] as const)
  process.on(event, (error: unknown) => handleHostFailure(label, error))

let recovery = readRecoveryState(recoveryPath)
// 即使启动被拒绝，持久化的熔断状态仍须支持外部恢复。
if (recovery.tripped) phase = "tripped"
/** 保存熔断与恢复状态。 */
function saveRecovery(): void {
  saveRecoveryState(recoveryPath, recovery)
}

const updates = new UpdateService({
  pluginDir: fileURLToPath(new URL("../../", import.meta.url)),
  stateDir,
  settings: () => configuration.active.update,
  send: noticeToMasters,
  /** 暂存完成后排入生命周期队列。 */
  install(staged, from, rollback) {
    if (!enqueue({ type: "update", staged, from, rollback })) throw new Error(M.update.busy)
  },
  record,
})

/** 仅在业务进程已上线时送达主人。 */
function noticeToMasters(text: string): boolean {
  if (!worker?.online || worker.failure || worker.expectedExit) return false
  send(worker, { type: "update-notice", generation: worker.generation, text })
  return true
}

const alerts = new AlertService({
  settings: () => configuration.active,
  stateDir,
  projectId,
  send: noticeToMasters,
  record,
})
const profiles = new BehaviorProfile({
  file: path.join(stateDir, "profiles.json"),
  settings: () => configuration.active.baseline,
})
const sourceWatch = new SourceWatch({
  pluginsDir: path.join(root, "plugins"),
  stateDir,
  settings: () => configuration.active.sources,
  /** 插件来源变化走“来源”类告警。 */
  onChange(change) {
    alerts.raise("source", change.plugin, `【Yunzai Guard】${change.text}`, {
      key: `source:${change.plugin}:${change.type}`,
      plugin: change.plugin,
    })
  },
})
const anomalyLabels = {
  "new-target": "出现新行为",
  "rate-spike": "频率突增",
  "off-hours": "非常规时段活动",
  burst: "批量新目标",
} as const

/** 把画像异常记入日志，达到推送级别时告警。 */
function handleAnomaly(anomaly: Anomaly): void {
  record("behavior-anomaly", {
    plugin: anomaly.plugin,
    type: anomaly.type,
    severity: anomaly.severity,
    kind: anomaly.kind,
    key: anomaly.key,
  })
  if (!atLeast(anomaly.severity, configuration.active.baseline.minSeverity)) return
  alerts.raise(
    "anomaly",
    `${anomaly.plugin} ${anomalyLabels[anomaly.type]}`,
    `【Yunzai Guard】${anomaly.plugin} ${anomalyLabels[anomaly.type]}（${anomaly.severity === "high" ? "高" : anomaly.severity === "medium" ? "中" : "低"}风险）：${anomaly.key}。${anomaly.detail}`,
    {
      key: `anomaly:${anomaly.plugin}:${anomaly.type}:${anomaly.kind}:${anomaly.key}`,
      plugin: anomaly.plugin,
      severity: anomaly.severity,
    },
  )
}

/** 业务进程上报的事件：交给告警与行为画像，任何失败都不影响审计链路。 */
function observeEvent(event: Record<string, unknown>): void {
  try {
    alerts.onEvent(event)
    for (const anomaly of profiles.observe(event as unknown as ProfileEvent)) handleAnomaly(anomaly)
  } catch (error) {
    record("observer-error", { message: (error as Error).message })
  }
}

/** 发给业务进程的配置不含告警目标与密钥，避免被插件读取。 */
function forWorker(value: GuardSettings): GuardSettings {
  return parseSettings({
    ...value,
    alerts: {
      ...value.alerts,
      webhook: { url: "", secret: "", format: value.alerts.webhook.format },
    },
  })
}

/** 汇总宿主、业务进程与监控状态，供 status 与面板使用。 */
function status() {
  const runtimeSettings = worker?.settings ?? settings
  const sources = worker?.sandboxSources ?? sandboxSources
  return {
    configuration: configuration.state,
    update: updates.state(),
    phase,
    hostPid: process.pid,
    workerPid: worker?.child.pid,
    generation,
    projectId,
    lockPort: projectLockPort,
    lockType: projectLock?.kind,
    legacyPortExcluded: projectLock?.legacyPortExcluded ?? false,
    legacyBridgeUnavailable: projectLock?.legacyBridgeUnavailable ?? false,
    legacyBridgeReason: projectLock?.legacyBridgeReason,
    recoveryCount: recovery.failures.filter(
      item => item.time > Date.now() - settings.recovery.windowMs,
    ).length,
    trippedReason: recovery.tripped ? recovery.reason : undefined,
    logAvailable: auditSink.stats().available,
    auditDropped: auditBuffer.stats().dropped,
    auditPipeline: {
      buffer: auditBuffer.stats(),
      sink: auditSink.stats(),
      generation: worker?.audit.stats() ?? lastAudit,
      transport: {
        windows: worker?.windowsTransportStats?.() ?? lastWindowsTransport,
        broker: worker?.broker.transportStats() ?? lastBrokerTransport,
      },
    },
    invalidMessages,
    windowsCanonicalMetadata: worker?.windowsCanonicalStats?.() ?? lastWindowsCanonical,
    capabilities: capabilities(process.platform, runtimeSettings.isolationMode),
    namespacePid: worker?.reportedPid,
    activeNodeRuntimes: worker?.broker.activeRuntimes ?? 0,
    usage: worker?.usage?.latest,
    monitoring: monitorStatus(
      runtimeSettings.protect.targets,
      worker?.monitor,
      Boolean(worker?.child.connected && !worker.expectedExit && !worker.failure),
    ),
    pluginSandbox: {
      enabled:
        sources.length > 0 ||
        runtimeSettings.pluginSandbox.native.plugins.some(item => item.enabled),
      engine: sources.length
        ? sandboxEngineLabel()
        : runtimeSettings.pluginSandbox.native.plugins.some(item => item.enabled)
          ? "native-node"
          : "none",
      plugins: sources.map(({ id, sha256, capabilities }) => ({ id, sha256, capabilities })),
      native: {
        source: "configuration-only",
        plugins: runtimeSettings.pluginSandbox.native.plugins,
        runtimeEvidence: "native.process-started/native.process-closed audit events",
      },
    },
  }
}

/**
 * 开始系统层采样：新出现的外部 TCP 连接写入审计。
 * 这是事后观察，不能阻断，也无法归因到插件；需要拦截时使用系统隔离。
 */
function watchUsage(session: Session): void {
  const pid = session.child.pid
  if (!session.settings.monitor.process || !pid || session.usage) return
  session.usage = new UsageWatch(pid, (remote, usage) => {
    if (session !== worker) return
    auditBuffer.offer({
      type: "audit",
      details: {
        generation: session.generation,
        event: {
          kind: "network",
          operation: "connection.observed",
          target: `tcp://${remote}`,
          plugin: "unknown",
          action: "audit",
          timestamp: new Date(usage.sampledAt).toISOString(),
          details: {
            source: "os-sample",
            detection: "after-connect",
            blocked: false,
            processes: usage.processes,
          },
        },
      },
      time: usage.sampledAt,
    })
  })
  session.usage.start()
}

/** 向业务进程发送 IPC 消息，失败时标记该会话故障。 */
function send(session: Session, message: Record<string, unknown>): void {
  let failed = false
  const sendFailed = () => {
    if (failed) return
    failed = true
    session.audit.noteOutboundFailure("primary")
    if (!session.expectedExit) fail(session, "worker-ipc-send-failed")
  }
  if (!session.child.connected) {
    sendFailed()
    return
  }
  try {
    session.child.send(message, error => {
      if (error) sendFailed()
    })
  } catch {
    sendFailed()
  }
}

/** 标记当前会话故障并触发恢复。 */
function fail(session: Session, reason: string): void {
  if (session !== worker || session.failure || session.expectedExit || stopping) return
  session.failure = reason
  if (active?.type !== "configure" && active?.type !== "update")
    enqueue({ type: "recover", reason })
}

/** 校验并脱敏工作进程上报的事件。 */
function auditEvent(value: unknown): Record<string, unknown> | undefined {
  return sanitizeAuditEvent(value, redact)
}

/** 处理业务进程消息：握手、控制、审计与监控报告。 */
function onMessage(session: Session, raw: unknown): void {
  if (session !== worker) return
  const settings = session.settings
  const sandboxSources = session.sandboxSources
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("shape")
    if (Buffer.byteLength(JSON.stringify(raw)) > 65536) throw new Error("size")
    const message = raw as Record<string, unknown>
    if (
      session.expectedExit &&
      !["audit", "violation", "audit-seal"].includes(String(message.type))
    )
      return
    if (message.type === "preload-hello") {
      if (
        session.handshaken ||
        message.projectId !== projectId ||
        !Number.isSafeInteger(message.pid) ||
        Number(message.pid) < 1 ||
        (settings.isolationMode === "managed" && message.pid !== session.child.pid) ||
        (process.platform === "win32" &&
          settings.isolationMode === "os-sandbox" &&
          message.pid !== (session.child as WindowsSandboxProcess).sandboxPid) ||
        typeof message.nonce !== "string" ||
        !/^[a-z\d-]{16,128}$/i.test(message.nonce)
      )
        throw new Error("hello")
      session.handshaken = true
      session.reportedPid = Number(message.pid)
      session.verifyControl = createControlVerifier(
        session.controlKey,
        session.generation,
        session.reportedPid,
      )
      const handshake = {
        type: "worker-handshake",
        nonce: message.nonce,
        projectId,
        generation: session.generation,
        auditChannelNonce: session.auditChannelNonce,
        controlKey: session.controlKey,
        settings: forWorker(settings),
        runtimeManifest: session.broker.manifestPath,
        sandboxSources,
      }
      if (sandboxSources.length && Buffer.byteLength(JSON.stringify(handshake)) > 60000) {
        fail(session, "sandbox-handshake-too-large")
        return
      }
      send(session, handshake)
      return
    }
    if (
      !session.handshaken ||
      message.generation !== session.generation ||
      message.pid !== session.reportedPid
    )
      throw new Error("identity")
    if (isControlType(message.type) && !session.verifyControl?.(message))
      throw new Error("control-auth")
    if (message.auditProtocol !== undefined) {
      session.audit.receive("primary", message, frame => send(session, { ...frame }))
      return
    }
    switch (message.type) {
      case "monitor-report":
        session.monitor = {
          report: parseMonitorReport(message.report, settings.protect.targets.length),
          receivedAt: Date.now(),
        }
        return
      case "preload-ready":
        if (!session.preloaded) record("preload-ready", { generation: session.generation })
        session.preloaded = true
        return
      case "worker-online":
        if (!session.preloaded) throw new Error("online-before-preload")
        if (!session.online) {
          record("worker-online", { workerPid: session.child.pid, generation: session.generation })
          watchUsage(session)
        }
        const first = !session.online
        session.online = true
        if (first) {
          updates.flush()
          alerts.flush()
        }
        return
      case "restart-request":
        enqueue({ type: "restart" })
        return
      case "stop-request":
        enqueue({ type: "stop" })
        return
      case "rollback-request":
        void requestRollback()
        return
      case "update-request":
      case "update-force-request":
        void requestUpdate(message.type === "update-force-request")
        return
      case "audit":
      case "violation": {
        const authorized = authorizeHostEvent(settings, message.event)
        const event = auditEvent(authorized)
        if (!event) throw new Error("event")
        observeEvent(event)
        if (event.action === "restart")
          fail(session, `policy-violation:${String(event.ruleId || event.kind)}`)
        auditBuffer.offer(
          {
            type: event.action === "restart" ? "violation" : "audit",
            details: { generation: session.generation, event },
            time: Date.now(),
          },
          { critical: event.action === "deny" || event.action === "restart" },
        )
        return
      }
      default:
        throw new Error("unknown type")
    }
  } catch {
    invalidMessages++
  }
}

/** 启动新一代业务进程并完成握手。 */
async function startWorker(): Promise<void> {
  if (stopping) return
  const sessionSettings = settings
  if (worker) throw new Error(M.host.previousWorker)
  if (process.platform === "win32" && sessionSettings.isolationMode === "managed")
    assertOriginalWindowsChildProbeRuntime()
  phase = "starting"
  const currentGeneration = ++generation
  const sessionEnvironment: NodeJS.ProcessEnv =
    sessionSettings.isolationMode === "os-sandbox"
      ? {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          LOCALAPPDATA: process.env.LOCALAPPDATA,
          LANG: process.env.LANG,
          TZ: process.env.TZ,
        }
      : { ...process.env }
  let session: Session | undefined
  const auditChannelNonce = randomBytes(24).toString("hex")
  const audit = new AuditReceiver({
    generation: currentGeneration,
    buffer: auditBuffer,
    authorize: event => {
      const authorized = auditEvent(authorizeHostEvent(sessionSettings, event))
      if (authorized) observeEvent(authorized)
      return authorized
    },
    /** 宿主重算为 restart 时请求重建业务进程。 */
    onAction(event) {
      if (session && event.action === "restart")
        fail(session, `policy-violation:${String(event.ruleId || event.kind)}`)
    },
    /** 累计无效消息。 */
    onInvalid() {
      invalidMessages++
    },
  })
  audit.register("primary", auditChannelNonce, "primary-ipc")
  const broker = new RuntimeBroker(
    sessionSettings,
    currentGeneration,
    projectId,
    (type, event) => {
      if (!session || session !== worker) return
      onMessage(session, { type, event, generation: session.generation, pid: session.reportedPid })
    },
    {
      /** 登记代理转来的审计来源。 */
      onSource(source) {
        audit.register(`broker:${source.key}`, source.channelNonce, source.transport)
      },
      /** 接收代理转来的审计帧。 */
      onObservation({ key, frame }, reply) {
        audit.receive(`broker:${key}`, frame, reply)
      },
      /** 接收代理转来的密封帧。 */
      onSeal({ key, frame }, reply) {
        audit.receive(`broker:${key}`, frame, reply)
      },
      /** 代理连接断开时退役对应来源。 */
      onDrop({ key, counters }) {
        // 传输写入错误已计入 counters.unknown。
        audit.drop(`broker:${key}`, counters.unknown + counters.invalidFrames)
      },
    },
  )
  const env: NodeJS.ProcessEnv = {
    ...sessionEnvironment,
    app_type: "start",
    YUNZAI_GUARD_MANAGED: "1",
    YUNZAI_GUARD_HANDSHAKE_TIMEOUT: String(sessionSettings.handshakeTimeout),
    YUNZAI_GUARD_RUNTIME_MANIFEST: broker.manifestPath,
  }
  delete env.NODE_OPTIONS
  delete env.YUNZAI_GUARD_PM2_TICKET
  const args = [
    "--import",
    new URL("../worker-preload.js", import.meta.url).href,
    path.join(root, "app.js"),
    "start",
  ]
  let child: ChildProcess | undefined
  const ownChild = (
    original: ChildProcess,
    resources: Pick<
      Session,
      "dispose" | "waitScopeExit" | "windowsTransportStats" | "windowsCanonicalStats"
    > = {},
  ): Session => {
    const current: Session = {
      settings: sessionSettings,
      sandboxSources,
      child: original,
      generation: currentGeneration,
      online: false,
      handshaken: false,
      preloaded: false,
      expectedExit: false,
      descendants: [],
      broker,
      audit,
      auditChannelNonce,
      controlKey: randomBytes(32).toString("hex"),
      ...resources,
    }
    session = worker = current
    original.on("message", message => onMessage(current, message))
    original.on("error", error => {
      record("worker-error", { message: error.message, generation: currentGeneration })
      fail(current, "worker-spawn-error")
    })
    original.once("exit", (code, signal) => {
      current.usage?.stop()
      record("worker-exit", {
        workerPid: original.pid,
        generation: currentGeneration,
        code,
        signal,
      })
      if (!current.expectedExit) fail(current, "worker-unexpected-exit")
    })
    original.once("close", (code, signal) => {
      record("worker-close", {
        workerPid: original.pid,
        generation: currentGeneration,
        code,
        signal,
      })
    })
    original.once("disconnect", () => {
      current.audit.drop("primary")
      if (!current.expectedExit) fail(current, "worker-ipc-disconnected")
    })
    record("worker-spawn", { workerPid: original.pid, generation: currentGeneration })
    return current
  }
  try {
    await broker.listen(
      process.platform === "win32" && sessionSettings.isolationMode === "os-sandbox",
    )
    if (sessionSettings.isolationMode === "os-sandbox" && process.platform === "win32") {
      const sandbox = spawnWindowsSandbox(root, sessionSettings, {
        executable: process.execPath,
        args,
        env,
        runtimeManifest: broker.manifestPath,
      })
      child = sandbox
      ownChild(sandbox, {
        dispose: () => sandbox.sandboxDispose(),
        windowsTransportStats: () => sandbox.sandboxTransportStats(),
        windowsCanonicalStats: () => sandbox.sandboxCanonicalStats(),
      })
      sandbox.on("runtime-message", (frame: { clientId: number; pid: number; message: unknown }) =>
        broker.receiveNative(
          String(frame.clientId),
          frame.message,
          message => sandbox.runtimeSend(frame.clientId, message),
          () => sandbox.runtimeClose(frame.clientId),
        ),
      )
      sandbox.on("runtime-close", (frame: { clientId: number }) =>
        broker.dropNative(String(frame.clientId)),
      )
    } else {
      const spec =
        sessionSettings.isolationMode === "os-sandbox"
          ? buildLinuxSandbox(root, sessionSettings, {
              executable: process.execPath,
              args,
              env,
              runtimeManifest: broker.manifestPath,
            })
          : {
              executable: process.execPath,
              args,
              env,
              cwd: root,
              extraStdio: [],
              dispose: () => {},
            }
      const stdio: import("node:child_process").StdioOptions = ["inherit", "pipe", "pipe", "ipc"]
      for (const extra of spec.extraStdio) stdio[extra.fd] = extra.source
      if ("statusFd" in spec) stdio[spec.statusFd] = "pipe"
      const allocationErrors: unknown[] = []
      try {
        child = spawn(spec.executable, spec.args, {
          cwd: root,
          env: spec.env,
          detached: process.platform !== "win32",
          windowsHide: true,
          stdio,
        })
        const current = ownChild(child)
        current.waitOutput = pipeHostOutput(child)
        if (process.platform === "win32" && sessionSettings.isolationMode === "managed")
          prepareDescendantCapture(child)
        if ("observe" in spec) {
          current.waitScopeExit = () => spec.waitForExit(current.child)
          spec.observe(child)
        }
      } catch (error) {
        allocationErrors.push(error)
      }
      try {
        spec.dispose()
      } catch (error) {
        allocationErrors.push(error)
      }
      if (allocationErrors.length === 1) throw allocationErrors[0]
      if (allocationErrors.length) throw new AggregateError(allocationErrors, M.host.workerRelease)
    }
  } catch (error) {
    try {
      if (session) {
        session.failure ||= "worker-startup-initialization-failed"
        await stopWorker()
      } else await broker.close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], M.host.workerStartupCleanup)
    }
    throw error
  }
  const current = session!
  child = current.child
  await until(
    () => current.online || Boolean(current.failure) || hasExited(current.child) || stopping,
    sessionSettings.startupTimeout,
  ).catch(() => {
    current.failure ||= "worker-startup-timeout"
  })
  if (stopping) return
  if (!current.online || current.failure || hasExited(child)) {
    fail(current, current.failure || "worker-startup-failed")
    // IPC 或退出处理器可能已通过 fail 设置 session.failure。
    if (active?.type !== "configure")
      enqueue({ type: "recover", reason: current.failure || "worker-startup-failed" })
    return
  }
  phase = "online"
  if (supervisedIpc && process.connected) {
    try {
      process.send?.("ready", error => {
        if (error) enqueue({ type: "stop" })
      })
    } catch {
      enqueue({ type: "stop" })
    }
  }
}

/** 停止当前业务进程并结算审计。 */
async function stopWorker(): Promise<void> {
  const session = worker
  if (!session) return
  const settings = session.settings
  session.expectedExit = true
  // 观察失败不能阻止关闭已经持有的资源。
  if (!session.closeAudit && process.platform === "win32" && settings.isolationMode === "managed") {
    try {
      session.descendants.push(
        ...(await captureDescendants(session.child, 12000 + settings.shutdownTimeout + 5000)),
      )
    } catch (error) {
      session.cleanupError ??= (error as Error).message
    }
  }
  retireDescendantCapture(session.child)
  // 独立的限时观察结束后，仍为资源关闭保留原定宽限期。
  const close = (session.closeAudit ??= {
    nonce: randomBytes(24).toString("hex"),
    deadline: createAuditDeadline(settings.shutdownTimeout),
  })
  session.audit.prepare(close)
  session.broker.prepareAudit(close)
  send(session, {
    auditProtocol: 1,
    type: "audit-prepare-flush",
    generation: session.generation,
    channelNonce: session.auditChannelNonce,
    closeNonce: close.nonce,
    remainingBudgetMs: close.deadline.remainingMs(),
    scope: "this-source-only",
  })
  send(session, { type: "shutdown", generation: session.generation })
  const cleanupFailures: Error[] = []
  const attempt = async (stage: string, action: () => unknown | Promise<unknown>) => {
    try {
      await action()
    } catch (error) {
      cleanupFailures.push(error as Error)
      record("worker-cleanup-error", {
        stage,
        generation: session.generation,
        message: (error as Error).message,
      })
    }
  }
  while (!hasExited(session.child) && close.deadline.remainingMs() > 0)
    await sleep(Math.min(20, close.deadline.remainingMs()))
  // 某项传输或资源失败，不能跳过其他已持有资源的清理。
  await attempt("runtime-broker", () => session.broker.close(close))
  if (!hasExited(session.child))
    record("worker-force-kill", { workerPid: session.child.pid, generation: session.generation })
  await attempt("os-scope-dispose", () => session.dispose?.())
  await attempt("worker-tree", () =>
    terminateWorkerTree(session.child, session.descendants, {
      ownedOsScope: settings.isolationMode === "os-sandbox",
    }),
  )
  await attempt("os-scope-exit", () => session.waitScopeExit?.())
  await attempt("worker-output", () => session.waitOutput?.(settings.shutdownTimeout))
  await attempt("audit-tail", () => session.audit.flush())
  lastAuditPermit = session.audit.closePermitForHost()
  lastAudit = session.audit.stats()
  lastWindowsTransport = session.windowsTransportStats?.()
  lastWindowsCanonical = session.windowsCanonicalStats?.()
  lastBrokerTransport = session.broker.transportStats()
  recordAuditCoverage("generation-close")
  record("runtime-broker-transport-summary", {
    generation: session.generation,
    stage: "generation-close",
    counterUnit: "channel-operations-and-incidents-not-audit-records",
    ...lastBrokerTransport,
  })
  if (lastWindowsTransport)
    record("windows-transport-summary", {
      generation: session.generation,
      stage: "generation-close",
      ...lastWindowsTransport,
    })
  if (lastWindowsCanonical)
    record("windows-canonical-metadata-summary", {
      generation: session.generation,
      stage: "generation-close",
      ...lastWindowsCanonical,
    })
  record("audit-generation-close", {
    generation: session.generation,
    activeSources: lastAudit.sources.length,
    retiredSources: lastAudit.retired.sources,
    coverageRecords: "audit-coverage-summary/audit-source-summary/audit-retired-summary",
    buffer: auditBuffer.stats(),
    sink: auditSink.stats(),
  })
  if (session.cleanupError) cleanupFailures.push(new Error(session.cleanupError))
  if (cleanupFailures.length) throw new AggregateError(cleanupFailures, M.host.workerCleanup)
  if (worker === session) worker = undefined
}

/** 触发熔断，停止自动恢复。 */
function trip(reason: string): void {
  if (pending?.type !== "stop") pending = undefined
  recovery.tripped = true
  recovery.reason = redact(reason)
  phase = "tripped"
  try {
    saveRecovery()
  } catch {
    logAvailable = false
    console.error(M.host.recoveryPersist)
  }
  record("recovery-tripped", { reason, failures: recovery.failures.length })
  alerts.raise(
    "tripped",
    "业务进程熔断",
    `【Yunzai Guard】业务进程连续故障，已熔断：${redact(reason)}。修正后请在控制台或用 resume 命令解除熔断`,
  )
}

/** 按退避策略恢复业务进程，超过上限时熔断。 */
async function recover(reason: string): Promise<void> {
  try {
    await stopWorker()
  } catch (error) {
    trip(`cleanup-unconfirmed:${(error as Error).message}`)
    return
  }
  if (stopping) return
  const now = Date.now()
  recovery.failures = recovery.failures.filter(item => item.time > now - settings.recovery.windowMs)
  recovery.failures.push({ time: now, reason: redact(reason) })
  if (recovery.failures.length > settings.recovery.maxRestarts) {
    trip(reason)
    return
  }
  try {
    saveRecovery()
  } catch {
    trip("recovery-state-write-failed")
    return
  }
  phase = "backoff"
  const delay = Math.min(
    settings.recovery.maxDelayMs,
    settings.recovery.baseDelayMs * 2 ** Math.min(recovery.failures.length - 1, 20),
  )
  record("recovery-scheduled", { reason, delay, count: recovery.failures.length })
  const deadline = Date.now() + delay
  while (!stopping && Date.now() < deadline) await sleep(Math.min(25, deadline - Date.now()))
  if (!stopping) await startWorker()
}

const priority: Record<Action["type"], number> = {
  start: 0,
  restart: 1,
  resume: 2,
  configure: 2,
  recover: 3,
  update: 3,
  stop: 4,
}

/** 按保留天数清理审计事件与宿主日志。 */
function pruneLogs(): void {
  const active = configuration.active
  try {
    const events = auditSink.pruneByAge(active.audit.maxDays)
    const logs = pruneHostLog(stateDir, active.log.maxDays)
    if (events || logs) record("log-pruned", { events, logs })
  } catch (error) {
    record("log-prune-failed", { message: (error as Error).message })
  }
}

/** 处理主人命令触发的更新，拒绝原因回复给主人。 */
async function requestUpdate(force: boolean): Promise<void> {
  const result = await updates.apply(force)
  if (!result.ok) updates.notify(`【Yunzai Guard】${result.message}`)
}

/** 处理主人命令触发的还原，拒绝原因回复给主人。 */
async function requestRollback(): Promise<void> {
  const result = await updates.rollback()
  if (!result.ok) updates.notify(`【Yunzai Guard】${result.message}`)
}

/** 停止业务进程、替换文件并重新上线；新版本无法上线时还原。 */
async function applyUpdate(staged: StagedRelease, from: string, rollback = false): Promise<void> {
  const to = staged.version
  phase = "restarting"
  record("update-begin", { from, to })
  await sleep(1500)
  await stopWorker()
  let handle: ReturnType<UpdateService["swap"]>
  try {
    handle = updates.swap(staged)
  } catch (error) {
    if (!stopping) await startWorker()
    updates.finish({ ok: false, from, to, message: (error as Error).message, relaunch: false })
    return
  }
  if (stopping) return handle.commit()
  if (rollback) {
    // 旧版本的业务进程不能由新宿主拉起，宿主带着旧文件重新启动。
    handle.commit()
    relaunch = Boolean(bootstrapPid) || process.env.YUNZAI_GUARD_COLD === "1"
    if (external) exitCode = 0
    updates.finish({ ok: true, from, to, relaunch: relaunch || external, rollback: true })
    enqueue({ type: "stop" })
    return
  }
  try {
    await startWorker()
  } catch (error) {
    record("update-start-failed", { message: (error as Error).message })
  }
  if (!worker?.online || worker.failure) {
    try {
      await stopWorker()
    } catch (error) {
      record("update-stop-failed", { message: (error as Error).message })
      throw error
    }
    handle.rollback()
    try {
      if (!stopping) await startWorker()
    } catch (error) {
      record("update-restore-failed", { message: (error as Error).message })
    }
    updates.finish({ ok: false, from, to, message: M.update.unhealthy, relaunch: false })
    return
  }
  handle.commit()
  relaunch = !stopping && (Boolean(bootstrapPid) || process.env.YUNZAI_GUARD_COLD === "1")
  // 外部管理器会在宿主以 0 退出后重新执行 node . start，届时由新文件接管。
  if (external && !stopping) exitCode = 0
  updates.finish({ ok: true, from, to, relaunch: relaunch || (external && !stopping) })
  if (relaunch || (external && !stopping)) enqueue({ type: "stop" })
}

/** 加入生命周期动作队列，停止动作优先；返回是否接收或合并，避免更新被静默丢弃。 */
function enqueue(action: Action): boolean {
  if (action.type === "stop") {
    bootstrapAbort.abort()
    stopping = true
    phase = "stopping"
  } else if (bootstrapPending) {
    record("bootstrap-action-rejected", { action: action.type })
    return false
  } else if (
    stopping ||
    (recovery.tripped && action.type !== "resume" && action.type !== "configure")
  )
    return false
  if (action.type === "restart" && (active?.type === "restart" || pending?.type === "restart")) {
    record("restart-coalesced", { generation })
    return true
  }
  if (action.type === "resume" && (active?.type === "resume" || pending?.type === "resume"))
    return true
  const accepted = !pending || priority[action.type] > priority[pending.type]
  if (accepted) pending = action
  if (!pumping) void pump()
  return accepted
}

/** 关闭宿主：停止业务进程、面板与控制端点。 */
async function closeHost(): Promise<void> {
  updates.stop()
  alerts.stop()
  sourceWatch.stop()
  profiles.flush()
  bootstrapAbort.abort()
  await bootstrapHandoff?.catch(() => {})
  const lastSession = worker
  await stopWorker()
  const permit =
    lastSession?.audit.closePermitForHost() ??
    lastAuditPermit ??
    auditBuffer.createClosePermit({
      generation: Math.max(1, generation),
      nonce: randomBytes(24).toString("hex"),
      deadline: createAuditDeadline(settings.shutdownTimeout),
    })
  const auditClose = await auditBuffer.close(permit)
  lastAudit = lastSession?.audit.stats() ?? lastAudit
  lastWindowsTransport = lastSession?.windowsTransportStats?.() ?? lastWindowsTransport
  lastWindowsCanonical = lastSession?.windowsCanonicalStats?.() ?? lastWindowsCanonical
  lastBrokerTransport = lastSession?.broker.transportStats() ?? lastBrokerTransport
  recordAuditCoverage("host-stop")
  if (lastBrokerTransport)
    record("runtime-broker-transport-summary", {
      stage: "host-stop",
      counterUnit: "channel-operations-and-incidents-not-audit-records",
      ...lastBrokerTransport,
    })
  if (lastWindowsTransport)
    record("windows-transport-summary", { stage: "host-stop", ...lastWindowsTransport })
  if (lastWindowsCanonical)
    record("windows-canonical-metadata-summary", { stage: "host-stop", ...lastWindowsCanonical })
  record("host-stop", {
    code: exitCode,
    auditClose,
    auditGeneration: lastAudit?.generation,
    activeSources: lastAudit?.sources.length,
    retiredSources: lastAudit?.retired.sources,
    coverageRecords: "audit-coverage-summary/audit-source-summary/audit-retired-summary",
    auditSink: auditSink.stats(),
  })
  try {
    const value = JSON.parse(fs.readFileSync(controlPath, "utf8")) as {
      hostPid?: number
      token?: string
    }
    if (value.hostPid === process.pid && value.token === token)
      fs.rmSync(controlPath, { force: true })
  } catch {
    // 不删除无法识别的控制文件。
  }
  await new Promise<void>(resolve => server.close(() => resolve()))
  await stopPanel()
  await projectLock?.close()
  process.exit(exitCode)
}

/** 依次执行队列中的生命周期动作。 */
async function pump(): Promise<void> {
  pumping = true
  while (pending) {
    active = pending
    pending = undefined
    try {
      switch (active.type) {
        case "stop":
          await closeHost()
          break
        case "start":
          if (recovery.tripped) phase = "tripped"
          else if (!worker) await startWorker()
          break
        case "restart":
          phase = "restarting"
          record("restart-begin", { generation })
          await stopWorker()
          if (!stopping) await startWorker()
          if (worker?.online && !worker.failure && !stopping)
            record("restart-complete", { generation })
          break
        case "resume":
          await stopWorker()
          recovery = { version: 1, failures: [], tripped: false }
          saveRecovery()
          record("recovery-resumed")
          if (!stopping) await startWorker()
          break
        case "recover":
          await recover(active.reason || "unknown-worker-failure")
          break
        case "update":
          await applyUpdate(active.staged!, active.from ?? "unknown", active.rollback)
          break
        case "configure":
          await configuration.applyPending()
          record(`configuration-${configuration.state.status}`, { ...configuration.state })
          if (worker?.failure && !stopping && !recovery.tripped)
            enqueue({ type: "recover", reason: worker.failure })
          break
      }
    } catch (error) {
      record("lifecycle-error", { action: active.type, message: (error as Error).message })
      if (active.type === "update")
        updates.finish({
          ok: false,
          from: active.from ?? "unknown",
          to: active.staged?.version ?? "unknown",
          message: (error as Error).message,
          relaunch: false,
        })
      if (active.type === "stop") {
        stopping = false
        trip("stop-cleanup-failed")
      } else if (worker && !worker.expectedExit) {
        enqueue({ type: "recover", reason: (error as Error).message })
      } else trip(`lifecycle-failed:${(error as Error).message}`)
    }
    active = undefined
    if (!pending && configuration.hasPending && !stopping) pending = { type: "configure" }
  }
  pumping = false
}

const server = createControlServer({
  token,
  /** 处理控制命令。 */
  handle(command) {
    if (command === "restart") enqueue({ type: "restart" })
    if (command === "resume" && phase === "tripped") enqueue({ type: "resume" })
    if (command === "check-update") void updates.check(true)
    if (command === "rollback") void requestRollback()
    if (command === "update" || command === "force-update")
      void requestUpdate(command === "force-update")
    if (command === "invoke-bot-restart" && worker)
      send(worker, { type: "invoke-bot-restart", generation: worker.generation })
    return status()
  },
  /** 命令响应发出后执行停止。 */
  after(command) {
    if (command === "stop") setTimeout(() => enqueue({ type: "stop" }), 25)
  },
})

try {
  projectLock = await acquireProjectLock({
    projectId,
    controlPath,
    legacyServer: requestedControlPort === projectLockPort ? server : undefined,
  })
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen({ host: "127.0.0.1", port: requestedControlPort, exclusive: true }, resolve)
    })
  }
  controlPort = (server.address() as net.AddressInfo).port
} catch (error) {
  await projectLock?.close()
  console.error(M.host.lockRejected((error as NodeJS.ErrnoException).code ?? "unconfirmed"))
  process.exit(2)
}
try {
  auditSink = new SqliteAuditSink({
    filePath: path.join(stateDir, "events.sqlite"),
    maxBytes: settings.audit.maxBytes,
    maxFiles: settings.audit.maxFiles,
    durability: settings.audit.durability,
  })
} catch (error) {
  await projectLock.close()
  console.error(M.host.auditInitFailed((error as Error).message))
  process.exit(2)
}
server.on("error", error => {
  record("control-server-error", { message: error.message })
  exitCode = 1
  enqueue({ type: "stop" })
})
for (const lockServer of projectLock.servers.filter(item => item !== server))
  lockServer.on("error", error => {
    record("project-lock-error", { message: error.message })
    exitCode = 1
    enqueue({ type: "stop" })
  })

record("host-lock-acquired", {
  bootstrapPid,
  port: controlPort,
  lockPort: projectLockPort,
  lockType: projectLock.kind,
  legacyPortExcluded: projectLock.legacyPortExcluded,
  legacyBridgeUnavailable: projectLock.legacyBridgeUnavailable,
  legacyBridgeReason: projectLock.legacyBridgeReason,
  capabilities: capabilities(process.platform, settings.isolationMode),
})
const controlTemporary = `${controlPath}.${randomBytes(8).toString("hex")}.tmp`
fs.writeFileSync(
  controlTemporary,
  JSON.stringify({ token, port: controlPort, hostPid: process.pid, projectId }),
  { mode: 0o600, flag: "wx" },
)
try {
  fs.renameSync(controlTemporary, controlPath)
} finally {
  if (fs.existsSync(controlTemporary)) fs.unlinkSync(controlTemporary)
}
hostReady = true
process.on("exit", code => {
  record("host-process-exit", { code })
  auditSink.close()
  if (!relaunch) return
  try {
    spawn(process.execPath, [fileURLToPath(new URL("./supervisor.js", import.meta.url))], {
      cwd: process.cwd(),
      env: { ...process.env, YUNZAI_GUARD_COLD: "1" },
      stdio: process.platform === "win32" ? "ignore" : "inherit",
      windowsHide: true,
      detached: true,
    }).unref()
  } catch {
    // 无法拉起时宿主照常退出，由使用者手动启动。
  }
})
process.on("SIGINT", () => enqueue({ type: "stop" }))
process.on("SIGTERM", () => enqueue({ type: "stop" }))
process.on("message", (message: unknown) => {
  if (message === "shutdown") enqueue({ type: "stop" }) // 处理 PM2 的 shutdown_with_message 关闭通知。
})
if (supervisedIpc) process.once("disconnect", () => enqueue({ type: "stop" }))
for (const stream of [process.stdout, process.stderr])
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") enqueue({ type: "stop" })
    else if (stream.listenerCount("error") === 1) throw error
  })
try {
  if (bootstrapPid && !stopping) {
    bootstrapHandoff = waitForBootstrapHandoff({
      bootstrapPid,
      redisPid: bootstrapRedisPid,
      timeout: settings.handshakeTimeout + settings.shutdownTimeout,
      signal: bootstrapAbort.signal,
      bound: identities => record("bootstrap-resources-bound", { identities }),
    })
    await bootstrapHandoff
    record("bootstrap-exit-confirmed", { bootstrapPid })
  }
  bootstrapPending = false
  // 接管确认后再启动控制台：面板故障不会影响交接，此刻宿主已经是唯一权威。
  await startPanel({
    root: process.cwd(),
    stateDir,
    settings,
    getSettings: () => configuration.active,
    configuration: () => configuration.state,
    applySettings: next => {
      const state = configuration.request(next)
      enqueue({ type: "configure" })
      return state
    },
    status,
    controllers: {
      alerts: {
        history: limit => alerts.history(limit),
        testWebhook: () => alerts.testWebhook(),
      },
      profiles,
      sources: sourceWatch,
    },
    update: {
      state: () => updates.state(),
      check: () => updates.check(true),
      apply: force => updates.apply(force),
      rollback: () => updates.rollback(),
    },
    restart: () => enqueue({ type: "restart" }),
    resume: () => enqueue({ type: "resume" }),
    audit: record,
  })
  if (!stopping) enqueue({ type: "start" })
  if (!stopping) updates.start()
  if (!stopping) sourceWatch.start()
  pruneLogs()
  setInterval(pruneLogs, 3600000).unref()
  setInterval(() => {
    for (const anomaly of profiles.tick()) handleAnomaly(anomaly)
  }, 30000).unref()
} catch (error) {
  if (!stopping) {
    record("handoff-failed", { message: (error as Error).message })
    exitCode = 1
    enqueue({ type: "stop" })
  }
}
