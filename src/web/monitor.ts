import fs from "node:fs"
import path from "node:path"
import { evaluatePolicy, matchGlob, kindMatches } from "../config/policy.js"
import { redactAuditText } from "../audit/redaction.js"
import { auditDatabasePath } from "../audit/database.js"
import type { GuardAction, GuardEvent, GuardSettings } from "../shared/types.js"
import { listPlugins } from "./plugins.js"
import { readSqliteAudit, readSqlitePluginStats, timelineBucket } from "./audit-sqlite.js"
import { M } from "../shared/messages.js"

type Row = Record<string, unknown>
type AuditAction = GuardAction | "info"
export interface AuditQuery {
  page?: unknown
  pageSize?: unknown
  plugin?: unknown
  kind?: unknown
  action?: unknown
  q?: unknown
  from?: unknown
  to?: unknown
  scope?: unknown
}
export interface AuditEntry {
  id: string
  time: number
  type: string
  sequence?: number
  hostPid?: number
  generation?: number
  plugin: string
  kind: string
  operation: string
  target: string
  action: AuditAction
  ruleId?: string
  blocked?: boolean
  details: Row
}
export interface AuditCoverage {
  source: "retained-audit-window" | "sqlite-history"
  complete: false
  truncated: boolean
  bytesRead: number
  recordsRead: number
  invalidLines: number
  filesRead: number
  filesSkipped: number
  errors: string[]
  windowStart?: number
  windowEnd?: number
  lossReported: boolean
  latestReports: AuditEntry[]
}
export interface AuditSummary {
  total: number
  audit: number
  deny: number
  restart: number
  info: number
  unknownPlugin: number
  kinds: Record<string, number>
  timeline: {
    time: number
    total: number
    audit: number
    deny: number
    restart: number
    info: number
  }[]
  windowStart?: number
  windowEnd?: number
}
export interface AuditPage {
  items: AuditEntry[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
  summary: AuditSummary
  facets: { plugins: string[]; kinds: string[]; actions: AuditAction[] }
  coverage: AuditCoverage
  storage?: {
    engine: "sqlite"
    available: boolean
    retainedRecords: number
    retainedBytes: number
    evictedRecords: number
    legacyImported?: number
  }
}

const maxBytes = 4 * 1024 * 1024
const maxRecords = 20000
const maxLineBytes = 128 * 1024
const maxFiles = 100
const minTimelineSpanMs = 30 * 60 * 1000
const actions: AuditAction[] = ["audit", "deny", "restart", "info"]
const queryKeys = ["page", "pageSize", "plugin", "kind", "action", "q", "from", "to", "scope"]
const windows = new WeakMap<AuditPage, AuditEntry[]>()
const databases = new WeakMap<AuditPage, string>()
const secretKey =
  /token|password|passwd|secret|authorization|cookie|args|environment|headers|api[_-]?key|credential/i
/** 判断为非数组的普通对象。 */
const row = (value: unknown): value is Row =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** 递归清洗并截断展示数据。 */
function clean(value: unknown, depth = 0, budget = { nodes: 512 }): unknown {
  if (--budget.nodes < 0 || depth > 6) return "[truncated]"
  if (typeof value === "string") return redactAuditText(value)
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.slice(0, 64).map(item => clean(item, depth + 1, budget))
  if (!row(value)) return null
  const result: Row = Object.create(null)
  for (const [key, item] of Object.entries(value).slice(0, 64))
    result[key] = secretKey.test(key) ? "[redacted]" : clean(item, depth + 1, budget)
  return result
}

/** 取非空字符串并截断。 */
function text(value: unknown, limit = 512): string | undefined {
  if (value === undefined || value === "") return undefined
  if (typeof value !== "string" || value.length > limit || /[\u0000-\u001f]/.test(value))
    throw new TypeError(M.web.filterText)
  return value
}

/** 解析整数查询参数并限制上限。 */
function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === "") return fallback
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || number > max)
    throw new TypeError(M.web.filterPage)
  return number
}

/** 解析时间查询参数，支持时间戳与日期字符串。 */
function instant(value: unknown): number | undefined {
  if (value === undefined || value === "") return undefined
  const date =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? /^\d+$/.test(value)
          ? Number(value)
          : Date.parse(value)
        : NaN
  if (!Number.isFinite(date) || date < 0 || date > 8640000000000000)
    throw new TypeError(M.web.filterTime)
  return date
}

/** 把请求参数规范为审计查询。 */
function queryOf(input: AuditQuery | URLSearchParams) {
  const data: Row = input instanceof URLSearchParams ? Object.fromEntries(input) : (input as Row)
  if (!row(data) || Object.keys(data).some(key => !queryKeys.includes(key)))
    throw new TypeError(M.web.filterUnknown)
  const action = text(data.action, 16)
  if (action !== undefined && !actions.includes(action as AuditAction))
    throw new TypeError(M.web.filterAction)
  const from = instant(data.from),
    to = instant(data.to)
  if (from !== undefined && to !== undefined && from > to) throw new TypeError(M.web.filterRange)
  return {
    page: integer(data.page, 1, 20000),
    pageSize: integer(data.pageSize, 25, 100),
    plugin: text(data.plugin, 128),
    kind: text(data.kind, 128),
    action,
    q: text(data.q)?.toLowerCase(),
    from,
    to,
    scope: data.scope === "behavior" ? ("behavior" as const) : undefined,
  }
}

/** 把旧 JSONL 记录转为审计条目。 */
function entryOf(value: unknown, id: string): AuditEntry | undefined {
  if (
    !row(value) ||
    typeof value.type !== "string" ||
    value.type.length > 100 ||
    typeof value.time !== "number" ||
    !Number.isFinite(value.time) ||
    value.time < 0 ||
    value.time > 8640000000000000
  )
    return undefined
  const event = row(value.event) ? value.event : undefined
  const string = (input: unknown, fallback: string) =>
    typeof input === "string" && input ? redactAuditText(input) : fallback
  const eventAction = event?.action
  const action = actions.includes(eventAction as AuditAction)
    ? (eventAction as AuditAction)
    : "info"
  const result: AuditEntry = {
    id,
    time: value.time,
    type: value.type,
    plugin: string(event?.plugin ?? value.plugin, "unknown"),
    kind: string(event?.kind, value.type.startsWith("audit-") ? "coverage" : "system"),
    operation: string(event?.operation, value.type),
    target: string(event?.target, "—"),
    action,
    details: clean(value) as Row,
  }
  for (const key of ["sequence", "hostPid", "generation"] as const)
    if (typeof value[key] === "number" && Number.isSafeInteger(value[key])) result[key] = value[key]
  if (result.hostPid !== undefined && result.sequence !== undefined)
    result.id = `${result.hostPid}:${result.sequence}:${result.time}`
  if (typeof event?.ruleId === "string") result.ruleId = redactAuditText(event.ruleId)
  const blocked = event?.blocked ?? (row(event?.details) ? event.details.blocked : undefined)
  if (typeof blocked === "boolean") result.blocked = blocked
  return result
}

/** 读取旧 JSONL 日志窗口及其覆盖情况。 */
function windowOf(stateDir: string): { entries: AuditEntry[]; coverage: AuditCoverage } {
  const entries: AuditEntry[] = []
  const identities = new Set<string>()
  let examined = 0
  const coverage: AuditCoverage = {
    source: "retained-audit-window",
    complete: false,
    truncated: false,
    bytesRead: 0,
    recordsRead: 0,
    invalidLines: 0,
    filesRead: 0,
    filesSkipped: 0,
    errors: [],
    lossReported: false,
    latestReports: [],
  }
  for (let rotation = 0; rotation < maxFiles; rotation++) {
    const name = rotation ? `events.jsonl.${rotation}` : "events.jsonl"
    const filename = path.join(stateDir, name)
    let descriptor: number | undefined
    try {
      const info = fs.lstatSync(filename)
      if (!info.isFile() || info.isSymbolicLink()) {
        coverage.filesSkipped++
        continue
      }
      if (coverage.bytesRead >= maxBytes || examined >= maxRecords) {
        coverage.truncated = true
        coverage.filesSkipped++
        continue
      }
      descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      const stat = fs.fstatSync(descriptor)
      if (!stat.isFile()) {
        coverage.filesSkipped++
        continue
      }
      const size = Math.min(stat.size, maxBytes - coverage.bytesRead)
      const begin = stat.size - size
      const buffer = Buffer.alloc(size)
      const read = fs.readSync(descriptor, buffer, 0, size, begin)
      coverage.bytesRead += read
      coverage.filesRead++
      if (begin) coverage.truncated = true
      let lines = buffer.subarray(0, read).toString("utf8").split("\n")
      if (begin) lines = lines.slice(1)
      for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index]!.trim()
        if (!line) continue
        if (examined++ >= maxRecords) {
          coverage.truncated = true
          break
        }
        if (Buffer.byteLength(line) > maxLineBytes) {
          coverage.invalidLines++
          continue
        }
        try {
          const parsed = entryOf(JSON.parse(line), `${rotation}:${stat.size}:${index}`)
          if (parsed && !identities.has(parsed.id)) {
            entries.push(parsed)
            identities.add(parsed.id)
          } else if (parsed) continue
          else coverage.invalidLines++
        } catch {
          coverage.invalidLines++
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        coverage.filesSkipped++
        if (coverage.errors.length < 8)
          coverage.errors.push(`${name}: ${(error as NodeJS.ErrnoException).code ?? "unreadable"}`)
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
    }
  }
  entries.sort((a, b) => b.time - a.time || (b.sequence ?? 0) - (a.sequence ?? 0))
  coverage.recordsRead = entries.length
  coverage.windowStart = entries.at(-1)?.time
  coverage.windowEnd = entries[0]?.time
  coverage.latestReports = entries
    .filter(item =>
      ["audit-source-summary", "audit-retired-summary", "audit-coverage-summary"].includes(
        item.type,
      ),
    )
    .slice(0, 12)
  coverage.lossReported = entries.some(item => {
    const detail = item.details
    return (
      item.kind === "coverage" &&
      (Number(detail.incomplete ?? 0) > 0 ||
        Number(detail.unknown ?? 0) > 0 ||
        Number(detail.rejected ?? 0) > 0 ||
        detail.outcome === "incomplete" ||
        detail.outcome === "settled-with-loss")
    )
  })
  return { entries, coverage }
}

/** 汇总条目的类型、动作与插件分布。 */
function summarize(entries: AuditEntry[]): AuditSummary {
  const result: AuditSummary = {
    total: entries.length,
    audit: 0,
    deny: 0,
    restart: 0,
    info: 0,
    unknownPlugin: 0,
    kinds: Object.create(null),
    timeline: [],
  }
  for (const entry of entries) {
    result[entry.action]++
    if (entry.plugin === "unknown") result.unknownPlugin++
    result.kinds[entry.kind] = (result.kinds[entry.kind] ?? 0) + 1
  }
  result.windowStart = entries.at(-1)?.time
  result.windowEnd = entries[0]?.time
  if (result.windowStart !== undefined && result.windowEnd !== undefined) {
    // 事件集中在很短的时间内时，至少展示 30 分钟，避免整张图只有一根柱子。
    const { size: bucketMs, start } = timelineBucket(
      Math.min(result.windowStart, result.windowEnd - minTimelineSpanMs),
      result.windowEnd,
    )
    const count = Math.floor((result.windowEnd - start) / bucketMs) + 1
    result.timeline = Array.from({ length: count }, (_, index) => ({
      time: start + index * bucketMs,
      total: 0,
      audit: 0,
      deny: 0,
      restart: 0,
      info: 0,
    }))
    for (const entry of entries) {
      const bucket = result.timeline[Math.floor((entry.time - start) / bucketMs)]!
      bucket.total++
      bucket[entry.action]++
    }
  }
  return result
}

const cacheTtlMs = 2000
const cacheEntries = 16
const pageCache = new Map<
  string,
  { stateDir: string; at: number; stamp: string; page: AuditPage }
>()
let cacheTimer: ReturnType<typeof setTimeout> | undefined

/** 在最早的缓存到期时释放结果，页面关闭后也不会长期持有审计窗口。 */
function scheduleCacheExpiry(): void {
  if (cacheTimer) clearTimeout(cacheTimer)
  cacheTimer = undefined
  if (!pageCache.size) return
  const expiresAt = Math.min(...[...pageCache.values()].map(value => value.at)) + cacheTtlMs
  cacheTimer = setTimeout(
    () => {
      cacheTimer = undefined
      const now = Date.now()
      for (const [key, value] of pageCache) if (now - value.at >= cacheTtlMs) pageCache.delete(key)
      scheduleCacheExpiry()
    },
    Math.max(1, expiresAt - Date.now()),
  )
  cacheTimer.unref()
}

/** 审计文件的大小与修改时间，任何写入都会改变它。 */
function auditStamp(stateDir: string): string {
  return ["events.sqlite", "events.sqlite-wal", "events.jsonl"]
    .map(name => {
      try {
        const info = fs.statSync(path.join(stateDir, name))
        return `${info.size}:${info.mtimeMs}`
      } catch {
        return "-"
      }
    })
    .join("|")
}

/**
 * 分页读取审计事件。面板多个卡片会在同一时刻发出相同查询，
 * 文件未变化时 2 秒内复用结果；不同分页共享旧 JSONL 窗口，文件变化或到期即释放。
 */
export function readAudit(stateDir: string, input: AuditQuery | URLSearchParams = {}): AuditPage {
  const key = `${stateDir}\0${JSON.stringify(input instanceof URLSearchParams ? [...input] : input)}`
  const stamp = auditStamp(stateDir)
  const now = Date.now()
  let snapshot: ReturnType<typeof windowOf> | undefined
  for (const [key, value] of pageCache) {
    if (now - value.at >= cacheTtlMs || (value.stateDir === stateDir && value.stamp !== stamp))
      pageCache.delete(key)
    else if (value.stateDir === stateDir) {
      const entries = windows.get(value.page)
      if (entries) snapshot = { entries, coverage: value.page.coverage }
    }
  }
  const cached = pageCache.get(key)
  if (cached) return cached.page
  const page = readAuditUncached(stateDir, input, snapshot)
  pageCache.delete(key)
  pageCache.set(key, { stateDir, at: now, stamp, page })
  while (pageCache.size > cacheEntries) pageCache.delete(pageCache.keys().next().value!)
  scheduleCacheExpiry()
  return page
}

/** 分页读取审计事件，优先使用 SQLite。 */
function readAuditUncached(
  stateDir: string,
  input: AuditQuery | URLSearchParams = {},
  snapshot?: ReturnType<typeof windowOf>,
): AuditPage {
  const query = queryOf(input)
  const file = auditDatabasePath(stateDir)
  const persisted = ["", "-wal", "-shm", "-journal"].some(suffix => {
    try {
      fs.lstatSync(file + suffix)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT"
    }
  })
  if (persisted) {
    const page = readSqliteAudit(file, query, entryOf)
    if (page.storage?.available) databases.set(page, file)
    return page
  }
  const { entries, coverage } = snapshot ?? windowOf(stateDir)
  const filtered = entries.filter(
    entry =>
      (!query.plugin || entry.plugin === query.plugin) &&
      (!query.kind || entry.kind === query.kind) &&
      (!query.action || entry.action === query.action) &&
      (query.scope !== "behavior" || entry.action !== "info") &&
      (query.from === undefined || entry.time >= query.from) &&
      (query.to === undefined || entry.time <= query.to) &&
      (!query.q ||
        [entry.plugin, entry.kind, entry.operation, entry.target, entry.type, entry.ruleId ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(query.q)),
  )
  const start = (query.page - 1) * query.pageSize
  const page: AuditPage = {
    items: filtered.slice(start, start + query.pageSize),
    total: filtered.length,
    page: query.page,
    pageSize: query.pageSize,
    hasMore: start + query.pageSize < filtered.length,
    summary: summarize(filtered),
    facets: {
      plugins: [...new Set(entries.map(entry => entry.plugin))].sort(),
      kinds: [...new Set(entries.map(entry => entry.kind))].sort(),
      actions: actions.filter(action => entries.some(entry => entry.action === action)),
    },
    coverage,
  }
  windows.set(page, entries)
  return page
}

const samples = [
  {
    id: "network",
    label: "网络访问",
    kind: "network",
    operation: "fetch",
    target: "https://example.invalid",
  },
  {
    id: "process",
    label: "进程执行",
    kind: "process",
    operation: "exec",
    target: "example-command",
  },
  { id: "worker", label: "Worker", kind: "process", operation: "worker", target: "worker-script" },
  {
    id: "filesystem",
    label: "文件写入",
    kind: "filesystem",
    operation: "fs.writeFile",
    target: "data/example.json",
  },
  {
    id: "native",
    label: "原生扩展",
    kind: "native",
    operation: "native.load",
    target: "addon.node",
  },
  {
    id: "listen",
    label: "端口监听",
    kind: "listen",
    operation: "socket.listen",
    target: "tcp://0.0.0.0:8080",
  },
  { id: "plugin", label: "插件调用", kind: "plugin", operation: "plugin.call", target: "handler" },
  {
    id: "hook",
    label: "Hook 变化",
    kind: "integrity",
    operation: "protected-target-change",
    target: "PluginsLoader.filtPermission",
  },
]

/** 已记录的原生扩展加载，按插件与路径去重，最新在前。 */
export function nativeExtensions(stateDir: string) {
  const page = readAudit(stateDir, { kind: "native", pageSize: 100 })
  const result = new Map<
    string,
    { plugin: string; target: string; lastAt: number; count: number }
  >()
  for (const item of page.items) {
    const key = `${item.plugin}\n${item.target}`
    const found = result.get(key)
    if (found) {
      found.count++
      found.lastAt = Math.max(found.lastAt, item.time)
    } else
      result.set(key, { plugin: item.plugin, target: item.target, lastAt: item.time, count: 1 })
  }
  return [...result.values()].sort((a, b) => b.lastAt - a.lastAt)
}

/** 汇总各插件的规则、最近活动与统计。 */
export function pluginMonitor(root: string, settings: GuardSettings, snapshot?: AuditPage) {
  const plugins = listPlugins(root)
  const file = snapshot ? databases.get(snapshot) : undefined
  const stored = file
    ? readSqlitePluginStats(
        file,
        plugins.map(plugin => plugin.id),
        entryOf,
      )
    : undefined
  const all = snapshot ? (windows.get(snapshot) ?? snapshot.items) : []
  return plugins.map(plugin => {
    const events = all.filter(event => event.plugin === plugin.id)
    const saved = stored?.get(plugin.id)
    const stats = saved ?? summarize(events)
    const lastEvent = saved?.lastEvent ?? events[0]
    const rules = settings.rules.flatMap((rule, index) =>
      !rule.plugin || matchGlob(rule.plugin, plugin.id) ? [{ index, ...rule }] : [],
    )
    const config = settings.pluginSandbox.native.plugins.find(item => item.id === plugin.id)
    return {
      ...plugin,
      stats: {
        total: stats.total,
        audit: stats.audit,
        deny: stats.deny,
        restart: stats.restart,
        ...(lastEvent ? { lastEventAt: lastEvent.time } : {}),
      },
      lastEvent,
      rules,
      permissions: samples.map(({ id, label, ...sample }) => {
        const event: GuardEvent = { ...sample, plugin: plugin.id }
        const decision = evaluatePolicy(settings, event)
        const matched = rules.findIndex(rule => rule.id === decision.ruleId)
        const preceding = matched < 0 ? rules : rules.slice(0, matched + 1)
        return {
          id,
          label,
          sample,
          ...decision,
          enforcement: id === "hook" ? "after-change" : "entrypoint",
          conditional: preceding.some(
            rule =>
              kindMatches(rule.kind, sample.kind) &&
              Boolean(
                (rule.target && rule.target !== "*") || (rule.operation && rule.operation !== "*"),
              ),
          ),
        }
      }),
      sandbox: { enabled: Boolean(config?.enabled), ...(config ? { config } : {}) },
      statsScope: !snapshot
        ? "unavailable"
        : snapshot.storage
          ? saved
            ? "sqlite-history"
            : "unavailable"
          : windows.has(snapshot)
            ? "retained-window"
            : "retained-page",
    }
  })
}
