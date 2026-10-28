import type { SandboxSettings } from "../plugin-sandbox/types.js"
export type GuardAction = "audit" | "deny" | "restart"

export interface GuardRule {
  id: string
  kind?: string | string[]
  plugin?: string
  operation?: string
  target?: string
  action: GuardAction
}

export interface GuardEvent {
  kind: string
  operation: string
  target: string
  plugin?: string
  action?: GuardAction
  ruleId?: string
  timestamp?: string
  details?: Record<string, unknown>
}

export interface GuardSettings {
  schemaVersion: 1
  controlPort?: number
  startupTimeout: number
  shutdownTimeout: number
  handshakeTimeout: number
  isolationMode: "managed" | "os-sandbox"
  pluginSandbox: SandboxSettings
  sandbox: {
    network: "none" | "host"
    writablePaths: string[]
    bwrapPath?: string
  }
  recovery: { maxRestarts: number; windowMs: number; baseDelayMs: number; maxDelayMs: number }
  audit: {
    maxEventsPerSecond: number
    maxQueue: number
    maxBytes: number
    maxFiles: number
    /** 审计事件保留天数；0 表示只按容量淘汰。 */
    maxDays: number
    /** 相同普通事件的合并窗口（毫秒），0 表示逐条记录。 */
    coalesceMs: number
    /** 写盘策略：adaptive 仅含拦截记录的批次强制落盘，full 每批都强制落盘。 */
    durability: "adaptive" | "full"
  }
  /** 宿主日志 host.log：单文件上限与保留天数（0 表示不按天数清理）。 */
  log: { maxBytes: number; maxDays: number }
  rules: GuardRule[]
  /** 业务行为观察范围；不影响 Guard 自保护。 */
  monitor: {
    /** 基于路径的 fs 入口：off 不记录，write 记录修改类操作，all 同时记录读取。 */
    files: "off" | "write" | "all"
    /** 宿主定期采样业务进程树的系统层 I/O 与 TCP 连接，覆盖原生扩展。 */
    process: boolean
  }
  /** 版本检查与通知；应用更新必须由主人触发。 */
  update: {
    check: boolean
    notify: boolean
    intervalMs: number
  }
  /** 告警：把拦截、熔断、完整性与异常行为推给主人或 Webhook。 */
  alerts: {
    enabled: boolean
    masters: boolean
    webhook: { url: string; secret: string; format: "json" | "text" }
    on: Record<
      "deny" | "restart" | "tripped" | "integrity" | "anomaly" | "source" | "update",
      boolean
    >
    forward: { actions: GuardAction[]; kinds: string[] }
    throttle: { windowMs: number; maxPerWindow: number }
  }
  /** 权限基线：学习期内记录每个插件的常规行为，之后出现新行为时提示。 */
  baseline: {
    enabled: boolean
    learnHours: number
    kinds: string[]
    ignore: string[]
    ignorePlugins: string[]
    learnAfterAlert: boolean
    maxPerPlugin: number
    /** 低于该级别的异常只记录，不推送。 */
    minSeverity: "low" | "medium" | "high"
    /** 频率突增：窗口内事件数明显高于该插件自己的历史水平。 */
    spike: { enabled: boolean; zScore: number; minCount: number; windowMs: number }
    /** 非常规时段：该插件在学习期从未活动过的时段出现行为。 */
    offHours: boolean
    /** 短时间内出现大量新目标，常见于扫描或数据外送。 */
    burst: { enabled: boolean; count: number; windowMs: number }
  }
  /** 插件来源校验：定期检查 Git 插件的提交与工作区是否被改动。 */
  sources: {
    enabled: boolean
    intervalMs: number
    ignore: string[]
    /** 发现哪类变化时通知：提交变化、工作区被改、远端地址变化。 */
    notify: { commit: boolean; dirty: boolean; remote: boolean }
  }
  protect: {
    enabled: boolean
    intervalMs: number
    action: GuardAction
    targets: string[]
    monitorInstrumentation: boolean
  }
}

export type EmitEvent = (event: GuardEvent) => void

export interface GuardContext {
  generation: number
  settings: GuardSettings
  send: (type: string, extra?: Record<string, unknown>) => void
  run: <T>(pluginName: string, callback: () => T) => T
  sandboxDispatch?: (event: Record<string, unknown>) => Promise<boolean>
  /** 请求宿主检查并应用更新；结果由宿主通过主人通知回复。 */
  requestUpdate?: (force: boolean) => void
  /** 请求还原到上一版本。 */
  requestRollback?: () => void
}

export interface CoreBot {
  restart: () => Promise<unknown>
  exitEvent: (reason?: string, timeout?: number) => Promise<void>
  redisExit?: () => Promise<unknown>
  once: (name: string, listener: (...args: unknown[]) => void) => unknown
  on: (name: string, listener: (...args: unknown[]) => void) => unknown
  off: (name: string, listener: (...args: unknown[]) => void) => unknown
  [key: string]: unknown
}
