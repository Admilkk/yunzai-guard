import path from "node:path"
import { canonical, plain, integer, writable } from "./god-context.js"
import { validateInspectorUrl } from "./inspector-session-v1.js"
import { ownData } from "./legacy-sidecar.js"
import type { Pm2ApplicationOptions, Pm2DaemonContext, Pm2DaemonEnvironment } from "./types.js"
import { M } from "../shared/messages.js"

export interface ApplicationIdentity {
  pmId: number
  uniqueId: string
  root: string
  appPath: string
  launcherPath: string
  shutdownTimeout: number
  startupTimeout: number
}

export const ticketKey = "YUNZAI_GUARD_PM2_TICKET"
/** 校验 PM2 应用登记选项与 daemon 上下文一致。 */
export function validateOptions(options: Pm2ApplicationOptions, context: Pm2DaemonContext): void {
  if (
    !plain(options) ||
    !integer(options.pmId, 0, 2147483647) ||
    !integer(options.pid, 2, 2147483647) ||
    !integer(options.expectedDaemonPid, 2, 2147483647) ||
    options.expectedDaemonPid !== context.daemonPid ||
    !integer(options.shutdownTimeout, 10, 120000) ||
    !integer(options.startupTimeout, 100, 300000) ||
    typeof options.requestRestart !== "boolean" ||
    typeof options.nonce !== "string" ||
    !/^[a-zA-Z0-9_-]{16,128}$/.test(options.nonce)
  )
    throw new Error(M.pm2.registrationRequest)
  for (const file of [options.root, options.launcherPath, options.pm2Root])
    if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error(M.pm2.registrationPaths)
  if (options.ownInspectorUrl !== undefined) validateInspectorUrl(options.ownInspectorUrl)
  if (
    options.requestRestart &&
    options.bootstrapRedisPid !== null &&
    !integer(options.bootstrapRedisPid, 2, 2147483647)
  )
    throw new Error(M.pm2.coldRedis)
  if (options.bootstrapRedisPid === options.pid) throw new Error(M.pm2.redisIsApp)
}
/** 生成受管子进程使用的环境变量。 */
export function nestedEnvironment(
  environment: Pm2DaemonEnvironment,
): Record<string, unknown> | undefined {
  if (!plain(environment)) throw new Error(M.pm2.appEnv)
  const nested = ownData(environment, "env")
  if (
    (nested !== undefined && !plain(nested)) ||
    (!Object.hasOwn(environment, "env") && Reflect.has(environment, "env"))
  )
    throw new Error(M.pm2.appEnv)
  if (nested) {
    const descriptor = Object.getOwnPropertyDescriptor(nested, "pm_id")
    if (
      (descriptor && (!("value" in descriptor) || !descriptor.configurable)) ||
      (!descriptor && Reflect.has(nested, "pm_id"))
    )
      throw new Error(M.pm2.nestedIdentity)
  }
  return nested as Record<string, unknown> | undefined
}
/** 生成应用启动参数补丁。 */
export function createPatch(
  environment: Pm2DaemonEnvironment,
  app: ApplicationIdentity,
): Record<string, unknown> {
  const nested = nestedEnvironment(environment)
  const codes = environment.stop_exit_codes ?? []
  const list = Array.isArray(codes) ? [...codes] : [codes]
  if (list.some(code => !/^-?\d+$/.test(String(code)) || !Number.isSafeInteger(Number(code))))
    throw new Error(M.pm2.stopExitCodes)
  if (!list.some(code => Number(code) === 78)) list.push(78)
  const finite = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
  const patch: Record<string, unknown> = {
    pm_id: app.pmId,
    unique_id: app.uniqueId,
    pm_cwd: app.root,
    pm_exec_path: app.launcherPath,
    exec_mode: "fork_mode",
    wait_ready: true,
    shutdown_with_message: true,
    kill_timeout: Math.max(finite(environment.kill_timeout), app.shutdownTimeout + 10000),
    listen_timeout: Math.max(finite(environment.listen_timeout), app.startupTimeout + 10000),
    stop_exit_codes: list,
  }
  writable(environment, [...Object.keys(patch), "env", ticketKey])
  if (nested) writable(nested, [...Object.keys(patch).filter(key => key !== "pm_id"), ticketKey])
  for (const record of [environment, nested]) {
    const descriptor = record && Object.getOwnPropertyDescriptor(record, ticketKey)
    if (descriptor && !descriptor.configurable) throw new Error(M.pm2.ticketMetadata)
  }
  return patch
}
/** 把补丁写入 PM2 应用环境。 */
export function commitPatch(
  environment: Pm2DaemonEnvironment,
  patch: Record<string, unknown>,
): void {
  Object.assign(environment, patch)
  // executeApp 在 fork 前用 env 覆盖自身元数据；必须同时固定这两层，
  // 防止过期的 ecosystem 环境变量将入口还原为 app.js。
  // PM2 save 仅移除外层 pm_id；保留内层 id 会在 resurrect 时
  // 绕过新守护进程的编号分配器，导致与其他应用冲突。
  environment.env ??= {}
  const { pm_id: _runtimeId, ...nestedPatch } = patch
  delete environment.env.pm_id
  Object.assign(environment.env, nestedPatch)
}
/** 判断 PM2 应用环境是否为目标应用。 */
export function matchesApplication(
  environment: Pm2DaemonEnvironment,
  app: ApplicationIdentity,
): boolean {
  if (
    environment.pm_id !== app.pmId ||
    environment.unique_id !== app.uniqueId ||
    environment.exec_mode !== "fork_mode" ||
    typeof environment.pm_cwd !== "string" ||
    typeof environment.pm_exec_path !== "string"
  )
    return false
  try {
    if (canonical(environment.pm_cwd) !== app.root) return false
    const script = canonical(environment.pm_exec_path)
    return script === app.appPath || script === app.launcherPath
  } catch {
    return false
  }
}
