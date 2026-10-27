import type { DatabaseSync, SQLInputValue } from "node:sqlite"
import { openAuditDatabase } from "../audit/database.js"
import type { AuditEntry, AuditPage, AuditSummary } from "./monitor.js"
import { M } from "../shared/messages.js"

type Row = Record<string, unknown>
type EntryParser = (value: unknown, id: string) => AuditEntry | undefined
export interface SqliteAuditQuery {
  page: number
  pageSize: number
  plugin?: string
  kind?: string
  action?: string
  q?: string
  from?: number
  to?: number
  /** behavior 只返回业务行为，排除宿主系统记录。 */
  scope?: "behavior"
}
export interface SqlitePluginStats {
  total: number
  audit: number
  deny: number
  restart: number
  lastEvent?: AuditEntry
}

const actions = ["audit", "deny", "restart", "info"] as const
const counts = `count(*) AS total,
  coalesce(sum(action='audit'),0) AS audit,coalesce(sum(action='deny'),0) AS deny,
  coalesce(sum(action='restart'),0) AS restart,coalesce(sum(action='info'),0) AS info`
/** 趋势图的时间分桶上限。 */
export const timelineBuckets = 24
const minute = 60000
const bucketSteps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080].map(
  value => value * minute,
)

/** 选择不超过分桶上限的最小整齐分桶，返回桶长与对齐后的起点。 */
export function timelineBucket(windowStart: number, windowEnd: number) {
  for (const size of bucketSteps) {
    const start = Math.floor(windowStart / size) * size
    if (Math.floor((windowEnd - start) / size) + 1 <= timelineBuckets) return { size, start }
  }
  let size = bucketSteps.at(-1)!
  while (
    Math.floor((windowEnd - Math.floor(windowStart / size) * size) / size) + 1 >
    timelineBuckets
  )
    size *= 2
  return { size, start: Math.floor(windowStart / size) * size }
}
/** 取有限数，否则为 0。 */
const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)

/** 把查询条件转为 SQL WHERE 子句与参数。 */
function filter(query: SqliteAuditQuery) {
  const clauses: string[] = []
  const values: SQLInputValue[] = []
  for (const key of ["plugin", "kind", "action"] as const)
    if (query[key]) {
      clauses.push(`${key}=?`)
      values.push(query[key])
    }
  if (query.from !== undefined) {
    clauses.push("time>=?")
    values.push(query.from)
  }
  if (query.to !== undefined) {
    clauses.push("time<=?")
    values.push(query.to)
  }
  if (query.scope === "behavior") clauses.push("action<>'info'")
  if (query.q) {
    clauses.push("instr(search,?)>0")
    values.push(query.q)
  }
  return { where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", values }
}

/** 统计符合条件事件的类型、动作与插件分布。 */
function summary(database: DatabaseSync, query: SqliteAuditQuery): AuditSummary {
  const { where, values } = filter(query)
  const row = database
    .prepare(
      `SELECT ${counts},coalesce(sum(plugin='unknown'),0) AS unknownPlugin,min(time) AS first,max(time) AS last FROM events${where}`,
    )
    .get(...values)!
  const result: AuditSummary = {
    total: number(row.total),
    audit: number(row.audit),
    deny: number(row.deny),
    restart: number(row.restart),
    info: number(row.info),
    unknownPlugin: number(row.unknownPlugin),
    kinds: Object.create(null),
    timeline: [],
  }
  for (const kind of database
    .prepare(`SELECT kind,count(*) AS total FROM events${where} GROUP BY kind`)
    .all(...values))
    result.kinds[String(kind.kind)] = number(kind.total)
  if (!result.total) return result
  result.windowStart = number(row.first)
  result.windowEnd = number(row.last)
  const { size: bucketMs, start } = timelineBucket(result.windowStart, result.windowEnd)
  result.timeline = Array.from(
    { length: Math.floor((result.windowEnd - start) / bucketMs) + 1 },
    (_, index) => ({
      time: start + index * bucketMs,
      total: 0,
      audit: 0,
      deny: 0,
      restart: 0,
      info: 0,
    }),
  )
  const buckets = database
    .prepare(
      `SELECT CAST((time-?)/? AS INTEGER) AS bucket,${counts} FROM events${where} GROUP BY bucket`,
    )
    .all(start, bucketMs, ...values)
  for (const row of buckets) {
    const bucket = result.timeline[number(row.bucket)]
    if (!bucket) continue
    bucket.total = number(row.total)
    for (const action of actions) bucket[action] = number(row[action])
  }
  return result
}

/** 读取审计元数据。 */
function metadata(database: DatabaseSync, key: string): unknown {
  const value = database.prepare("SELECT value FROM audit_meta WHERE key=?").get(key)?.value
  if (typeof value !== "string" || value.length > 16384) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/** 按条件分页读取 SQLite 审计事件。 */
export function readSqliteAudit(
  file: string,
  query: SqliteAuditQuery,
  parse: EntryParser,
): AuditPage {
  const page: AuditPage = {
    items: [],
    total: 0,
    page: query.page,
    pageSize: query.pageSize,
    hasMore: false,
    summary: {
      total: 0,
      audit: 0,
      deny: 0,
      restart: 0,
      info: 0,
      unknownPlugin: 0,
      kinds: Object.create(null),
      timeline: [],
    },
    facets: { plugins: [], kinds: [], actions: [] },
    coverage: {
      source: "sqlite-history",
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
    },
    storage: {
      engine: "sqlite",
      available: false,
      retainedRecords: 0,
      retainedBytes: 0,
      evictedRecords: 0,
    },
  }
  let database: DatabaseSync | undefined
  let transaction = false
  try {
    database = openAuditDatabase(file, true)
    database.exec("BEGIN")
    transaction = true
    const retained = database
      .prepare(
        "SELECT count(*) AS records,coalesce(sum(bytes),0) AS bytes,min(time) AS first,max(time) AS last,coalesce(max(loss_reported),0) AS loss FROM events",
      )
      .get()!
    const legacyValue = metadata(database, "legacyImport")
    const legacy = legacyValue && typeof legacyValue === "object" ? (legacyValue as Row) : {}
    const evictedRecords = number(metadata(database, "evictedRecords"))
    page.storage = {
      engine: "sqlite",
      available: true,
      retainedRecords: number(retained.records),
      retainedBytes: number(retained.bytes),
      evictedRecords,
      legacyImported: number(legacy.imported),
    }
    const coverage = page.coverage
    coverage.recordsRead = number(retained.records)
    coverage.filesRead = 1
    coverage.truncated = evictedRecords > 0 || legacy.truncated === true
    coverage.invalidLines = number(legacy.invalidLines)
    coverage.filesSkipped = number(legacy.filesSkipped)
    coverage.errors = Array.isArray(legacy.errors)
      ? legacy.errors.filter((value): value is string => typeof value === "string").slice(0, 8)
      : []
    coverage.lossReported = number(retained.loss) > 0
    if (coverage.recordsRead) {
      coverage.windowStart = number(retained.first)
      coverage.windowEnd = number(retained.last)
    }
    const entry = (row: Row) => {
      try {
        const payload = String(row.payload)
        coverage.bytesRead += Buffer.byteLength(payload)
        const result = parse(JSON.parse(payload), `sqlite:${row.id}`)
        if (!result) throw new Error(M.web.storedEvent)
        result.id = `sqlite:${row.id}`
        return result
      } catch {
        coverage.invalidLines++
        return undefined
      }
    }
    const { where, values } = filter(query)
    page.summary = summary(database, query)
    page.total = page.summary.total
    const offset = (query.page - 1) * query.pageSize
    page.hasMore = offset + query.pageSize < page.total
    page.items = database
      .prepare(`SELECT id,payload FROM events${where} ORDER BY time DESC,id DESC LIMIT ? OFFSET ?`)
      .all(...values, query.pageSize, offset)
      .flatMap(row => {
        const value = entry(row)
        return value ? [value] : []
      })
    for (const row of database
      .prepare(
        "SELECT id,payload FROM events WHERE type IN ('audit-source-summary','audit-retired-summary','audit-coverage-summary') ORDER BY time DESC,id DESC LIMIT 12",
      )
      .all()) {
      const value = entry(row)
      if (value) coverage.latestReports.push(value)
    }
    page.facets.plugins = database
      .prepare("SELECT DISTINCT plugin FROM events ORDER BY plugin LIMIT 20000")
      .all()
      .map(row => String(row.plugin))
    page.facets.kinds = database
      .prepare("SELECT DISTINCT kind FROM events ORDER BY kind LIMIT 20000")
      .all()
      .map(row => String(row.kind))
    const present = new Set(
      database
        .prepare("SELECT DISTINCT action FROM events")
        .all()
        .map(row => String(row.action)),
    )
    page.facets.actions = actions.filter(action => present.has(action))
    database.exec("COMMIT")
    transaction = false
  } catch (error) {
    if (transaction)
      try {
        database?.exec("ROLLBACK")
      } catch {}
    page.items = []
    page.coverage.errors.push(
      `events.sqlite: ${(error as NodeJS.ErrnoException).code ?? "unreadable"}`,
    )
    if (page.storage) page.storage.available = false
  } finally {
    database?.close()
  }
  return page
}

/** 按插件汇总事件数量与最近活动时间。 */
export function readSqlitePluginStats(
  file: string,
  plugins: string[],
  parse: EntryParser,
): Map<string, SqlitePluginStats> {
  const result = new Map<string, SqlitePluginStats>()
  let database: DatabaseSync | undefined
  try {
    database = openAuditDatabase(file, true)
    database.exec("BEGIN")
    const aggregate = database.prepare(`SELECT ${counts} FROM events WHERE plugin=?`)
    const latest = database.prepare(
      "SELECT id,payload FROM events WHERE plugin=? ORDER BY time DESC,id DESC LIMIT 1",
    )
    for (const plugin of plugins) {
      const row = aggregate.get(plugin)!
      const stats: SqlitePluginStats = {
        total: number(row.total),
        audit: number(row.audit),
        deny: number(row.deny),
        restart: number(row.restart),
      }
      const last = latest.get(plugin)
      if (last) {
        stats.lastEvent = parse(JSON.parse(String(last.payload)), `sqlite:${last.id}`)
        if (stats.lastEvent) stats.lastEvent.id = `sqlite:${last.id}`
      }
      result.set(plugin, stats)
    }
    database.exec("COMMIT")
  } catch {
    result.clear()
  } finally {
    database?.close()
  }
  return result
}
