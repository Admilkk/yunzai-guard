import fs from "node:fs"
import { GuardPanel } from "./server.js"
import type { GuardSettings } from "../shared/types.js"
import type { SettingsApplyState } from "../config/update.js"

let panel: GuardPanel | undefined

export interface StartPanelOptions {
  root: string
  stateDir: string
  settings: GuardSettings
  getSettings?: () => GuardSettings
  configuration?: () => SettingsApplyState
  applySettings?: (settings: GuardSettings) => SettingsApplyState
  status: () => Record<string, unknown>
  restart: () => void
  resume: () => void
  audit?: (type: string, details?: Record<string, unknown>) => void
}

/** 写入面板日志，失败时忽略。 */
function logLine(message: string): void {
  try {
    console.error(message)
  } catch {
    // 控制台句柄不可写（例如 detached 子进程继承了失效的 ConPTY）时忽略，
    // 面板仍可通过 HTTP 访问，验证码会同时落盘。
  }
}

/** 读取插件版本号。 */
function readVersion(): string {
  try {
    const packageFile = new URL("../../package.json", import.meta.url)
    const parsed = JSON.parse(fs.readFileSync(packageFile, "utf8")) as { version?: unknown }
    return typeof parsed.version === "string" ? parsed.version : "unknown"
  } catch {
    return "unknown"
  }
}

/** 面板与宿主同生命周期：宿主退出后端口随之释放，不会留下孤儿服务。 */
export async function startPanel(options: StartPanelOptions): Promise<void> {
  if (panel) return
  let instance: GuardPanel
  try {
    instance = new GuardPanel({ ...options, version: readVersion(), log: logLine })
  } catch (error) {
    // 面板配置损坏不能影响宿主接管业务进程。
    logLine(`[Yunzai Guard] 控制台初始化失败：${(error as Error).message}`)
    return
  }
  panel = instance
  try {
    await instance.start()
  } catch (error) {
    panel = undefined
    logLine(`[Yunzai Guard] 控制台启动失败：${(error as Error).message}`)
  }
}

/** 停止面板服务。 */
export async function stopPanel(): Promise<void> {
  const instance = panel
  panel = undefined
  await instance?.stop()
}
