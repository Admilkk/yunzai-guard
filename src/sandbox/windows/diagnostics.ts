export interface CanonicalSnapshot {
  protocol: 1
  enabled: boolean
  disabled: boolean
  offered: number
  acceptedRoot: number
  completed: number
  rejected: number
  unsupported: number
  timedOut: number
  unknown: number
}

export interface CanonicalStats {
  scope: "canonical-metadata-only"
  provenance: "native-broker-reported"
  capabilityRequested: boolean
  reports: { ready: boolean; exit: boolean; cleanup: boolean; invalid: number }
  latestStage?: "ready" | "exit" | "cleanup"
  snapshot?: CanonicalSnapshot
  cleanupConfirmed?: boolean
  cleanupUnknown: boolean
  finalSnapshotMissing: boolean
  nativeExit?: { code: number | null; signal: NodeJS.Signals | null }
  nativeOutputClosed: boolean
  /** 进程退出仅证明系统回收完成，不证明元数据查询完成。 */
  nativeHelperResourcesReleased: boolean
}

/** 每个观察器只属于一个原生 broker 进程。 */
export interface CanonicalObserver {
  invalid(stage?: "ready" | "exit" | "cleanup"): boolean
  record(stage: "ready" | "exit" | "cleanup", raw: unknown, cleanupConfirmed?: unknown): boolean
  nativeExit(code: number | null, signal: NodeJS.Signals | null): void
  outputClosed(): void
  stats(): CanonicalStats
}

const canonicalCounterNames = [
  "offered",
  "acceptedRoot",
  "completed",
  "rejected",
  "unsupported",
  "timedOut",
  "unknown",
] as const

/** 这些计数只统计原生操作和连接，不统计审计记录或追加次数。 */
export function createCanonicalObserver(capabilityRequested: boolean): CanonicalObserver {
  const ranks = { ready: 1, exit: 2, cleanup: 3 }
  const snapshots: Partial<Record<keyof typeof ranks, CanonicalSnapshot>> = {}
  const state: CanonicalStats = {
    scope: "canonical-metadata-only",
    provenance: "native-broker-reported",
    capabilityRequested,
    reports: { ready: false, exit: false, cleanup: false, invalid: 0 },
    cleanupUnknown: false,
    finalSnapshotMissing: false,
    nativeOutputClosed: false,
    nativeHelperResourcesReleased: false,
  }
  const invalid = () => {
    state.reports.invalid = addCounter(state.reports.invalid)
    return false
  }
  return {
    /** 标记诊断记录无效。 */
    invalid(stage?: "ready" | "exit" | "cleanup") {
      if (stage === "cleanup") state.cleanupUnknown = true
      return invalid()
    },
    /** 记录辅助程序在某阶段的诊断输出。 */
    record(stage: "ready" | "exit" | "cleanup", raw: unknown, cleanupConfirmed?: unknown) {
      const reject = () => {
        if (stage === "cleanup") state.cleanupUnknown = true
        return invalid()
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return reject()
      const value = raw as Record<string, unknown>
      const keys = Object.keys(value)
      if (
        keys.length !== 10 ||
        keys.some(
          key => !["protocol", "enabled", "disabled", ...canonicalCounterNames].includes(key),
        ) ||
        value.protocol !== 1 ||
        value.enabled !== capabilityRequested ||
        typeof value.disabled !== "boolean" ||
        canonicalCounterNames.some(
          key => !Number.isSafeInteger(value[key]) || Number(value[key]) < 0,
        ) ||
        Number(value.acceptedRoot) > 1 ||
        Number(value.acceptedRoot) > Number(value.offered) ||
        (!capabilityRequested &&
          (value.disabled !== true || canonicalCounterNames.some(key => value[key] !== 0))) ||
        (stage === "cleanup" && typeof cleanupConfirmed !== "boolean") ||
        (stage !== "cleanup" && cleanupConfirmed !== undefined) ||
        state.reports[stage]
      )
        return reject()
      for (const [otherStage, other] of Object.entries(snapshots)) {
        // stdout 与原 stderr 之间没有投递顺序保证；核验
        // 逻辑阶段的单调性，并保留最新的逻辑快照。
        const earlier = ranks[otherStage as keyof typeof ranks] < ranks[stage] ? other : value
        const later = earlier === other ? value : other
        if (
          (earlier.disabled && !later.disabled) ||
          canonicalCounterNames.some(key => Number(earlier[key]) > Number(later[key]))
        )
          return reject()
      }
      state.reports[stage] = true
      snapshots[stage] = {
        protocol: 1,
        enabled: capabilityRequested,
        disabled: value.disabled,
        ...Object.fromEntries(canonicalCounterNames.map(key => [key, Number(value[key])])),
      } as CanonicalSnapshot
      if (!state.latestStage || ranks[stage] > ranks[state.latestStage]) {
        state.latestStage = stage
        state.snapshot = snapshots[stage]
      }
      if (stage === "cleanup") {
        state.cleanupConfirmed = cleanupConfirmed as boolean
        if (!cleanupConfirmed) state.cleanupUnknown = true
      }
      return true
    },
    /** 记录辅助程序的退出码与信号。 */
    nativeExit(code: number | null, signal: NodeJS.Signals | null) {
      state.nativeExit = { code, signal }
      state.nativeHelperResourcesReleased = true
    },
    /** 标记辅助程序输出已关闭。 */
    outputClosed() {
      state.nativeOutputClosed = true
      state.finalSnapshotMissing = !state.reports.cleanup
      if (state.finalSnapshotMissing) state.cleanupUnknown = true
    },
    stats: (): CanonicalStats => structuredClone(state),
  }
}

export interface TransportCounters {
  scope: "windows-broker-transport-only"
  evidence: "transport-callback-and-forwarding-only"
  control: {
    offered: number
    accepted: number
    completed: number
    rejected: number
    unknown: number
    closed: number
  }
  output: {
    offeredBytes: number
    forwardedBytes: number
    droppedBytes: number
    unknownBytes: number
  }
  native: { closed: number; rejected: number; unknown: number }
}

/** 创建全零的传输计数。 */
export function createTransportCounters(): TransportCounters {
  return {
    scope: "windows-broker-transport-only",
    evidence: "transport-callback-and-forwarding-only",
    control: { offered: 0, accepted: 0, completed: 0, rejected: 0, unknown: 0, closed: 0 },
    output: { offeredBytes: 0, forwardedBytes: 0, droppedBytes: 0, unknownBytes: 0 },
    native: { closed: 0, rejected: 0, unknown: 0 },
  }
}

/** 饱和累加计数。 */
export function addCounter(value: number, amount = 1): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + amount)
}
