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
  audit: { maxEventsPerSecond: number; maxQueue: number; maxBytes: number; maxFiles: number }
  rules: GuardRule[]
  /** 业务行为观察范围；不影响 Guard 自保护。 */
  monitor: {
    /** 基于路径的 fs 入口：off 不记录，write 记录修改类操作，all 同时记录读取。 */
    files: "off" | "write" | "all"
    /** 宿主定期采样业务进程树的系统层 I/O 与 TCP 连接，覆盖原生扩展。 */
    process: boolean
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
