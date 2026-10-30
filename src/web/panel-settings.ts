import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { M } from "../shared/messages.js"
import { writeJsonFile } from "../shared/files.js"

/** 面板是宿主进程的附加入口：配置放在 Guard 状态目录，业务插件无法读写。 */
export interface PanelSettings {
  enabled: boolean
  host: string
  port: number
  tokenTtlHours: number
  trustedDeviceTtlDays: number
  trustProxy: boolean
  /** 允许局域网以外的来源访问；默认只开放本机与局域网。 */
  allowExternal: boolean
  /** 允许主人发送 #guard登录 获取一次性登录链接。 */
  chatLogin: boolean
  /** 登录链接使用的外部访问地址，例如反向代理后的域名；为空时使用监听地址。 */
  publicUrl: string
  jwtSecret: string
}

const maxSettingsBytes = 64 * 1024

/** 返回面板配置文件路径。 */
export function panelSettingsPath(stateDir: string): string {
  return path.join(stateDir, "panel.json")
}

/** 生成随机密钥。 */
export function randomSecret(): string {
  return randomBytes(24).toString("base64url")
}

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

/** 生成指定长度的数字验证码。 */
export function randomCode(length: number): string {
  const bytes = randomBytes(length * 2)
  let result = ""
  for (let index = 0; result.length < length && index < bytes.length; index++) {
    const value = bytes[index]
    if (value >= 256 - (256 % alphabet.length)) continue
    result += alphabet[value % alphabet.length]
  }
  return result.length === length ? result : randomSecret().slice(0, length)
}

/** 校验监听地址。 */
function validHost(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 255 &&
    (value === "localhost" || net.isIP(value) !== 0)
  )
}

/** 取范围内整数，否则使用默认值。 */
function integer(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback
}

/** 外部访问地址只接受不带查询与片段的 http(s) 地址。 */
function validPublicUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 300) return false
  try {
    const url = new URL(value)
    return (url.protocol === "http:" || url.protocol === "https:") && !url.search && !url.hash
  } catch {
    return false
  }
}

/** 规范化面板配置并补全默认值。 */
function normalize(value: unknown): PanelSettings {
  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : true,
    host: validHost(source.host) ? source.host : "0.0.0.0",
    port: integer(source.port, 21733, 1024, 65535),
    tokenTtlHours: integer(source.tokenTtlHours, 24, 1, 720),
    trustedDeviceTtlDays: integer(source.trustedDeviceTtlDays, 30, 1, 90),
    trustProxy: source.trustProxy === true,
    allowExternal: source.allowExternal === true,
    chatLogin: typeof source.chatLogin === "boolean" ? source.chatLogin : true,
    publicUrl: validPublicUrl(source.publicUrl) ? source.publicUrl : "",
    jwtSecret:
      typeof source.jwtSecret === "string" && source.jwtSecret.length >= 32
        ? source.jwtSecret
        : randomSecret(),
  }
}

/** 原子写入面板配置。 */
function writeSettings(file: string, settings: PanelSettings): void {
  writeJsonFile(file, settings, { pretty: true })
}

/** 字段损坏时回落到默认值并立即规范化落盘，避免面板因手改配置而无法启动。 */
export function loadPanelSettings(stateDir: string): PanelSettings {
  const file = panelSettingsPath(stateDir)
  let raw: string | undefined
  try {
    const info = fs.statSync(file)
    if (info.isFile() && info.size <= maxSettingsBytes) raw = fs.readFileSync(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  let parsed: unknown
  if (raw !== undefined) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
  }
  const settings = normalize(parsed)
  if (raw !== `${JSON.stringify(settings, null, 2)}\n`) writeSettings(file, settings)
  return settings
}

export interface PanelSettingsPatch {
  host?: string
  port?: number
  tokenTtlHours?: number
  trustedDeviceTtlDays?: number
  enabled?: boolean
  allowExternal?: boolean
  chatLogin?: boolean
  publicUrl?: string
}

/** 保留 secret，只覆盖面板可调项；非法值直接拒绝。 */
export function savePanelSettings(stateDir: string, patch: PanelSettingsPatch): PanelSettings {
  const file = panelSettingsPath(stateDir)
  const next: PanelSettings = { ...loadPanelSettings(stateDir) }
  if (patch.host !== undefined) {
    if (!validHost(patch.host)) throw new TypeError(M.web.host)
    next.host = patch.host
  }
  if (patch.port !== undefined) {
    if (!Number.isInteger(patch.port) || patch.port < 1024 || patch.port > 65535)
      throw new TypeError(M.web.port)
    next.port = patch.port
  }
  if (patch.tokenTtlHours !== undefined) {
    if (
      !Number.isInteger(patch.tokenTtlHours) ||
      patch.tokenTtlHours < 1 ||
      patch.tokenTtlHours > 720
    )
      throw new TypeError(M.web.tokenTtl)
    next.tokenTtlHours = patch.tokenTtlHours
  }
  if (patch.enabled !== undefined) next.enabled = patch.enabled
  if (patch.allowExternal !== undefined) next.allowExternal = patch.allowExternal
  if (patch.chatLogin !== undefined) next.chatLogin = patch.chatLogin
  if (patch.publicUrl !== undefined) {
    const value = patch.publicUrl.trim()
    if (value && !validPublicUrl(value)) throw new TypeError(M.web.publicUrl)
    next.publicUrl = value
  }
  if (patch.trustedDeviceTtlDays !== undefined) {
    if (
      !Number.isInteger(patch.trustedDeviceTtlDays) ||
      patch.trustedDeviceTtlDays < 1 ||
      patch.trustedDeviceTtlDays > 90
    )
      throw new TypeError(M.web.deviceTtl)
    next.trustedDeviceTtlDays = patch.trustedDeviceTtlDays
  }
  writeSettings(file, next)
  return next
}
