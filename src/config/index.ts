import fs from "node:fs"
import path from "node:path"
import type { GuardSettings } from "../shared/types.js"
import { action, boolean, keys, number, object, rule, string } from "./validation.js"
import { parsePluginSandbox } from "../plugin-sandbox/config.js"
import { freezeData } from "../protect/objects.js"
import { newWeakSet, weakSetAdd, weakSetHas } from "../protect/intrinsics.js"
import { defaultTargets } from "./targets.js"
import { parseAlerts, parseBaseline, parseSources } from "./extras.js"
import { M } from "../shared/messages.js"
import { parseWindow } from "../shared/update-window.js"

const maxSettingsBytes = 1024 * 1024
const parsedSettings = newWeakSet<GuardSettings>()
const cloneData = globalThis.structuredClone

/** 只复制已校验配置；不在业务运行后重新依赖可变的解析入口。 */
export function snapshotSettings(settings: GuardSettings): GuardSettings {
  if (!weakSetHas(parsedSettings, settings)) throw new TypeError(M.config.unparsed)
  const snapshot = freezeData(cloneData(settings))
  weakSetAdd(parsedSettings, snapshot)
  return snapshot
}

/** 解析并验证 JSON 配置；未知属性直接拒绝，不求值表达式。 */
export function parseSettings(value: unknown): GuardSettings {
  const source = object(value, "settings")
  keys(
    source,
    [
      "schemaVersion",
      "controlPort",
      "startupTimeout",
      "shutdownTimeout",
      "handshakeTimeout",
      "isolationMode",
      "sandbox",
      "recovery",
      "audit",
      "log",
      "rules",
      "monitor",
      "update",
      "alerts",
      "baseline",
      "sources",
      "protect",
      "strictJs",
      "pluginSandbox",
    ],
    "settings",
  )
  if (source.schemaVersion !== undefined && source.schemaVersion !== 1)
    throw new TypeError(M.config.schemaVersion)
  const isolationMode = source.isolationMode === undefined ? "managed" : source.isolationMode
  const pluginSandbox = parsePluginSandbox(source.pluginSandbox, source.strictJs)
  if (isolationMode !== "managed" && isolationMode !== "os-sandbox")
    throw new TypeError(M.config.isolationMode)
  const sandbox = object(source.sandbox === undefined ? {} : source.sandbox, "settings.sandbox")
  keys(sandbox, ["network", "writablePaths", "bwrapPath"], "settings.sandbox")
  const network = sandbox.network === undefined ? "none" : sandbox.network
  if (network !== "none" && network !== "host") throw new TypeError(M.config.network)
  const writablePaths =
    sandbox.writablePaths === undefined
      ? ["data", "temp", "logs", "config/config"]
      : sandbox.writablePaths
  if (!Array.isArray(writablePaths) || writablePaths.length > 32)
    throw new TypeError(M.config.writablePaths)
  const writable = writablePaths.map((item, i) => {
    const name = string(item, `settings.sandbox.writablePaths[${i}]`, 256)
    if (
      !/^[\w.-]+(?:\/[\w.-]+)*$/.test(name) ||
      name.split("/").some(part => part === "." || part === "..") ||
      /^(?:lib|plugins|node_modules|\.git)(?:\/|$)/.test(name) ||
      name === "config" ||
      name === "data/yunzai-guard" ||
      name.startsWith("data/yunzai-guard/")
    )
      throw new TypeError(M.config.unsafeWritablePath(name))
    return name
  })
  if (new Set(writable).size !== writable.length)
    throw new TypeError(M.config.writablePathsDuplicate)
  const bwrapPath =
    sandbox.bwrapPath === undefined
      ? undefined
      : string(sandbox.bwrapPath, "settings.sandbox.bwrapPath")
  if (bwrapPath !== undefined && !path.isAbsolute(bwrapPath))
    throw new TypeError(M.config.bwrapPath)
  const recovery = object(source.recovery === undefined ? {} : source.recovery, "settings.recovery")
  keys(recovery, ["maxRestarts", "windowMs", "baseDelayMs", "maxDelayMs"], "settings.recovery")
  const audit = object(source.audit === undefined ? {} : source.audit, "settings.audit")
  keys(
    audit,
    [
      "maxEventsPerSecond",
      "maxQueue",
      "maxBytes",
      "maxFiles",
      "maxDays",
      "coalesceMs",
      "durability",
    ],
    "settings.audit",
  )
  const durability = audit.durability ?? "adaptive"
  if (durability !== "adaptive" && durability !== "full") throw new TypeError(M.config.durability)
  const log = object(source.log === undefined ? {} : source.log, "settings.log")
  keys(log, ["maxBytes", "maxDays"], "settings.log")
  const monitor = object(source.monitor === undefined ? {} : source.monitor, "settings.monitor")
  keys(monitor, ["files", "process"], "settings.monitor")
  const files = monitor.files ?? "write"
  if (files !== "off" && files !== "write" && files !== "all")
    throw new TypeError(M.config.monitorFiles)
  const update = object(source.update === undefined ? {} : source.update, "settings.update")
  keys(
    update,
    ["check", "notify", "intervalMs", "workerRestart", "idleSeconds", "maxWaitHours", "window"],
    "settings.update",
  )
  const workerRestart = update.workerRestart ?? "idle"
  if (workerRestart !== "idle" && workerRestart !== "window" && workerRestart !== "now")
    throw new TypeError(M.config.workerRestart)
  const window = update.window ?? "03:00-06:00"
  if (typeof window !== "string" || !parseWindow(window)) throw new TypeError(M.config.updateWindow)
  const protect = object(source.protect === undefined ? {} : source.protect, "settings.protect")
  keys(
    protect,
    ["enabled", "intervalMs", "action", "targets", "monitorInstrumentation"],
    "settings.protect",
  )
  const targets = protect.targets === undefined ? defaultTargets : protect.targets
  if (!Array.isArray(targets) || targets.length > 256) throw new TypeError(M.config.targets)
  const paths = targets.map((target, i) => {
    const result = string(target, `settings.protect.targets[${i}]`)
    if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(result))
      throw new TypeError(M.config.targetPath(i))
    return result
  })
  if (new Set(paths).size !== paths.length) throw new TypeError(M.config.targetsDuplicate)
  const rules = source.rules === undefined ? [] : source.rules
  if (!Array.isArray(rules) || rules.length > 1000) throw new TypeError(M.config.rules)
  const parsedRules = rules.map(rule)
  if (new Set(parsedRules.map(item => item.id)).size !== parsedRules.length)
    throw new TypeError(M.config.rulesDuplicate)
  const result: GuardSettings = {
    schemaVersion: 1,
    startupTimeout: number(source.startupTimeout, 60000, "settings.startupTimeout", 100, 300000),
    shutdownTimeout: number(source.shutdownTimeout, 10000, "settings.shutdownTimeout", 10, 120000),
    handshakeTimeout: number(
      source.handshakeTimeout,
      5000,
      "settings.handshakeTimeout",
      100,
      120000,
    ),
    isolationMode,
    pluginSandbox,
    sandbox: { network, writablePaths: writable, ...(bwrapPath ? { bwrapPath } : {}) },
    recovery: {
      maxRestarts: number(recovery.maxRestarts, 3, "settings.recovery.maxRestarts", 0, 100),
      windowMs: number(recovery.windowMs, 60000, "settings.recovery.windowMs", 1000, 86400000),
      baseDelayMs: number(recovery.baseDelayMs, 250, "settings.recovery.baseDelayMs", 0, 60000),
      maxDelayMs: number(recovery.maxDelayMs, 30000, "settings.recovery.maxDelayMs", 0, 300000),
    },
    audit: {
      maxEventsPerSecond: number(
        audit.maxEventsPerSecond,
        1000,
        "settings.audit.maxEventsPerSecond",
        1,
        100000,
      ),
      maxQueue: number(audit.maxQueue, 5000, "settings.audit.maxQueue", 1, 100000),
      maxBytes: number(audit.maxBytes, 10485760, "settings.audit.maxBytes", 1024, 1073741824),
      maxFiles: number(audit.maxFiles, 3, "settings.audit.maxFiles", 1, 100),
      maxDays: number(audit.maxDays, 0, "settings.audit.maxDays", 0, 3650),
      coalesceMs: number(audit.coalesceMs, 1000, "settings.audit.coalesceMs", 0, 60000),
      durability,
    },
    log: {
      maxBytes: number(log.maxBytes, 4194304, "settings.log.maxBytes", 65536, 1073741824),
      maxDays: number(log.maxDays, 0, "settings.log.maxDays", 0, 3650),
    },
    rules: parsedRules,
    monitor: { files, process: boolean(monitor.process, true, "settings.monitor.process") },
    update: {
      check: boolean(update.check, true, "settings.update.check"),
      notify: boolean(update.notify, true, "settings.update.notify"),
      intervalMs: number(update.intervalMs, 300000, "settings.update.intervalMs", 60000, 86400000),
      workerRestart,
      idleSeconds: number(update.idleSeconds, 60, "settings.update.idleSeconds", 10, 3600),
      maxWaitHours: number(update.maxWaitHours, 6, "settings.update.maxWaitHours", 1, 72),
      window,
    },
    alerts: parseAlerts(source.alerts),
    baseline: parseBaseline(source.baseline),
    sources: parseSources(source.sources),
    protect: {
      enabled: boolean(protect.enabled, true, "settings.protect.enabled"),
      intervalMs: number(protect.intervalMs, 1000, "settings.protect.intervalMs", 10, 60000),
      action: action(protect.action, "audit", "settings.protect.action"),
      targets: paths,
      monitorInstrumentation: boolean(
        protect.monitorInstrumentation,
        true,
        "settings.protect.monitorInstrumentation",
      ),
    },
  }
  if (source.controlPort !== undefined && source.controlPort !== 0)
    result.controlPort = number(source.controlPort, 0, "settings.controlPort", 1024, 65535)
  if (result.recovery.maxDelayMs < result.recovery.baseDelayMs)
    throw new TypeError(M.config.recoveryDelay)
  // 插件上下文与同步钩子共用此快照；意外写入必须失败。
  for (const item of result.rules) {
    if (Array.isArray(item.kind)) Object.freeze(item.kind)
    Object.freeze(item)
  }
  Object.freeze(result.rules)
  Object.freeze(result.recovery)
  Object.freeze(result.audit)
  Object.freeze(result.log)
  Object.freeze(result.monitor)
  Object.freeze(result.update)
  for (const part of [result.alerts, result.baseline, result.sources]) {
    for (const value of Object.values(part))
      if (value && typeof value === "object") Object.freeze(value)
    Object.freeze(part)
  }
  Object.freeze(result.sandbox.writablePaths)
  Object.freeze(result.sandbox)
  Object.freeze(result.protect.targets)
  Object.freeze(result.protect)
  Object.freeze(result)
  weakSetAdd(parsedSettings, result)
  return result
}

/** 此文件由宿主管理；调用方应向 worker 传递已验证快照。 */
export function loadSettings(stateDir: string): GuardSettings {
  const filename = path.join(stateDir, "settings.json")
  let input: string
  try {
    const stat = fs.statSync(filename)
    if (!stat.isFile() || stat.size > maxSettingsBytes) throw new TypeError(M.config.fileSize)
    input = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      fs.readFileSync(filename),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseSettings({})
    throw error
  }
  if (input.charCodeAt(0) === 0xfeff) throw new TypeError(M.config.encoding)
  return parseSettings(JSON.parse(input))
}
