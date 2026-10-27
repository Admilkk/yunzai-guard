import type { BootstrapExitWatch } from "../host/bootstrap/exit-watch.js"
import type { Pm2LoggingUtility } from "./log-stream-gate-v1.js"

export interface Pm2Environment {
  pm_id?: string | number
  pm_exec_path?: string
  exec_mode?: string
  kill_timeout?: number
  pm_out_log_path?: string
  pm_err_log_path?: string
  pm_log_path?: string
}

export interface Pm2Process {
  pm2_env: Pm2Environment
  pid?: number
  exitCode?: number | null
  signalCode?: string | null
}

export type Pm2Callback = (this: unknown, ...args: unknown[]) => void

export interface Pm2God {
  clusters_db: Record<string, Pm2Process | undefined>
  processIsDead: (
    this: Pm2God,
    pid: number,
    environment: Pm2Environment,
    callback: Pm2Callback,
    sigkill?: boolean,
  ) => unknown
  handleExit: (this: Pm2God, child: Pm2Process, ...args: unknown[]) => unknown
}

export interface Pm2ApplicationOptions {
  pmId: number
  pid: number
  root: string
  launcherPath: string
  shutdownTimeout: number
  startupTimeout: number
  nonce: string
  requestRestart: boolean
  bootstrapRedisPid?: number | null
  expectedDaemonPid: number
  pm2Root: string
  ownInspectorUrl?: string
}

export interface Pm2InspectorCloseOptions {
  pmId: number
  pid: number
  nonce: string
  expectedDaemonPid: number
  pm2Root: string
  ownInspectorUrl?: string
  url?: string
}

export interface Pm2ApplicationRegistration {
  status: "registered"
  daemonPid: number
  pmId: number
  pid: number
  launcherPath: string
  requiresHandoff: boolean
  bootstrapExitBarrier?: 1
}

export interface Pm2DaemonEnvironment extends Pm2Environment {
  pm_cwd?: string
  unique_id?: string
  status?: string
  env?: Record<string, unknown>
  wait_ready?: boolean
  shutdown_with_message?: boolean
  listen_timeout?: number
  stop_exit_codes?: number | string | (number | string)[]
  YUNZAI_GUARD_PM2_TICKET?: string
}

export type ForkCallback = (this: unknown, error: unknown, child?: Pm2Process) => void
export interface Pm2DaemonGod extends Pm2God {
  forkMode: (this: Pm2DaemonGod, environment: Pm2DaemonEnvironment, cb: ForkCallback) => unknown
  restartProcessId: (
    this: Pm2DaemonGod,
    options: { id: number },
    cb: (error?: unknown) => void,
  ) => unknown
}

export interface Pm2DaemonContext {
  daemonPid: number
  loggingUtility?: Pm2LoggingUtility
  report?: (event: { event: string; pmId?: number | string; pid?: number; reason?: string }) => void
  inspector?: { url(): string | undefined; close(): void }
  watchBootstrapExit?: (
    pid: number,
    redisPid: number | null,
    timeout: number,
  ) => Promise<BootstrapExitWatch>
}
