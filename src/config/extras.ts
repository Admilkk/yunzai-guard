import type { GuardAction, GuardSettings } from "../shared/types.js"
import { M } from "../shared/messages.js"
import { boolean, keys, number, object } from "./validation.js"

type Alerts = GuardSettings["alerts"]
type Baseline = GuardSettings["baseline"]
type Sources = GuardSettings["sources"]

const actionNames: readonly GuardAction[] = ["audit", "deny", "restart"]
const alertCategories = [
  "deny",
  "restart",
  "tripped",
  "integrity",
  "anomaly",
  "source",
  "update",
  "security",
] as const

/** 读取字符串数组配置：元素非空、无控制字符，数量与长度有上限。 */
export function stringList(
  value: unknown,
  fallback: string[],
  location: string,
  maxItems = 100,
  maxLength = 256,
): string[] {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.length > maxItems)
    throw new TypeError(M.config.list(location, maxItems))
  const result = value.map((item, index) => {
    if (
      typeof item !== "string" ||
      !item.length ||
      item.length > maxLength ||
      /[\0\r\n]/.test(item)
    )
      throw new TypeError(M.config.string(`${location}[${index}]`, maxLength))
    return item
  })
  return [...new Set(result)]
}

/** 读取可为空的单行字符串，空串表示未设置。 */
function optionalText(value: unknown, location: string, maxLength: number): string {
  if (value === undefined || value === "") return ""
  if (typeof value !== "string" || value.length > maxLength || /[\0\r\n]/.test(value))
    throw new TypeError(M.config.string(location, maxLength))
  return value
}

/** 解析告警配置：通知渠道、触发类别、Webhook 转发范围与限流。 */
export function parseAlerts(value: unknown): Alerts {
  const source = object(value === undefined ? {} : value, "settings.alerts")
  keys(source, ["enabled", "masters", "webhook", "on", "forward", "throttle"], "settings.alerts")
  const webhook = object(
    source.webhook === undefined ? {} : source.webhook,
    "settings.alerts.webhook",
  )
  keys(webhook, ["url", "secret", "format"], "settings.alerts.webhook")
  const url = optionalText(webhook.url, "settings.alerts.webhook.url", 1024)
  if (url && !/^https?:\/\/[^\s/]+/i.test(url)) throw new TypeError(M.config.webhookUrl)
  const format = webhook.format === undefined ? "json" : webhook.format
  if (format !== "json" && format !== "text") throw new TypeError(M.config.webhookFormat)
  const on = object(source.on === undefined ? {} : source.on, "settings.alerts.on")
  keys(on, [...alertCategories], "settings.alerts.on")
  const forward = object(
    source.forward === undefined ? {} : source.forward,
    "settings.alerts.forward",
  )
  keys(forward, ["actions", "kinds"], "settings.alerts.forward")
  const actions = stringList(
    forward.actions,
    ["deny", "restart"],
    "settings.alerts.forward.actions",
    3,
    16,
  )
  if (actions.some(item => !actionNames.includes(item as GuardAction)))
    throw new TypeError(M.config.action("settings.alerts.forward.actions"))
  const throttle = object(
    source.throttle === undefined ? {} : source.throttle,
    "settings.alerts.throttle",
  )
  keys(throttle, ["windowMs", "maxPerWindow"], "settings.alerts.throttle")
  return {
    enabled: boolean(source.enabled, true, "settings.alerts.enabled"),
    masters: boolean(source.masters, true, "settings.alerts.masters"),
    webhook: {
      url,
      secret: optionalText(webhook.secret, "settings.alerts.webhook.secret", 256),
      format,
    },
    on: Object.fromEntries(
      alertCategories.map(name => [name, boolean(on[name], true, `settings.alerts.on.${name}`)]),
    ) as Alerts["on"],
    forward: {
      actions: actions as GuardAction[],
      kinds: stringList(forward.kinds, [], "settings.alerts.forward.kinds", 32, 64),
    },
    throttle: {
      windowMs: number(
        throttle.windowMs,
        60000,
        "settings.alerts.throttle.windowMs",
        1000,
        3600000,
      ),
      maxPerWindow: number(
        throttle.maxPerWindow,
        5,
        "settings.alerts.throttle.maxPerWindow",
        1,
        100,
      ),
    },
  }
}

/** 解析权限基线配置：学习时长、覆盖的行为类型、忽略项与上限。 */
export function parseBaseline(value: unknown): Baseline {
  const source = object(value === undefined ? {} : value, "settings.baseline")
  keys(
    source,
    [
      "enabled",
      "learnHours",
      "kinds",
      "ignore",
      "ignorePlugins",
      "learnAfterAlert",
      "maxPerPlugin",
      "minSeverity",
      "spike",
      "offHours",
      "burst",
    ],
    "settings.baseline",
  )
  const severity = source.minSeverity === undefined ? "medium" : source.minSeverity
  if (severity !== "low" && severity !== "medium" && severity !== "high")
    throw new TypeError(M.config.severity)
  const spike = object(source.spike === undefined ? {} : source.spike, "settings.baseline.spike")
  keys(spike, ["enabled", "zScore", "minCount", "windowMs"], "settings.baseline.spike")
  const burst = object(source.burst === undefined ? {} : source.burst, "settings.baseline.burst")
  keys(burst, ["enabled", "count", "windowMs"], "settings.baseline.burst")
  return {
    enabled: boolean(source.enabled, false, "settings.baseline.enabled"),
    learnHours: number(source.learnHours, 72, "settings.baseline.learnHours", 1, 8760),
    kinds: stringList(
      source.kinds,
      ["network", "listen", "process", "native"],
      "settings.baseline.kinds",
      32,
      64,
    ),
    ignore: stringList(source.ignore, [], "settings.baseline.ignore"),
    ignorePlugins: stringList(source.ignorePlugins, [], "settings.baseline.ignorePlugins"),
    learnAfterAlert: boolean(source.learnAfterAlert, true, "settings.baseline.learnAfterAlert"),
    maxPerPlugin: number(source.maxPerPlugin, 500, "settings.baseline.maxPerPlugin", 10, 5000),
    minSeverity: severity,
    spike: {
      enabled: boolean(spike.enabled, true, "settings.baseline.spike.enabled"),
      zScore: number(spike.zScore, 4, "settings.baseline.spike.zScore", 1, 50),
      minCount: number(spike.minCount, 30, "settings.baseline.spike.minCount", 1, 100000),
      windowMs: number(spike.windowMs, 600000, "settings.baseline.spike.windowMs", 60000, 3600000),
    },
    offHours: boolean(source.offHours, true, "settings.baseline.offHours"),
    burst: {
      enabled: boolean(burst.enabled, true, "settings.baseline.burst.enabled"),
      count: number(burst.count, 8, "settings.baseline.burst.count", 2, 1000),
      windowMs: number(burst.windowMs, 600000, "settings.baseline.burst.windowMs", 10000, 86400000),
    },
  }
}

/** 解析插件来源校验配置：扫描间隔与忽略的插件目录。 */
export function parseSources(value: unknown): Sources {
  const source = object(value === undefined ? {} : value, "settings.sources")
  keys(source, ["enabled", "intervalMs", "ignore", "notify"], "settings.sources")
  const notify = object(source.notify === undefined ? {} : source.notify, "settings.sources.notify")
  keys(notify, ["commit", "dirty", "remote"], "settings.sources.notify")
  return {
    enabled: boolean(source.enabled, true, "settings.sources.enabled"),
    intervalMs: number(source.intervalMs, 600000, "settings.sources.intervalMs", 60000, 86400000),
    ignore: stringList(source.ignore, [], "settings.sources.ignore", 100, 128),
    notify: {
      commit: boolean(notify.commit, false, "settings.sources.notify.commit"),
      dirty: boolean(notify.dirty, true, "settings.sources.notify.dirty"),
      remote: boolean(notify.remote, true, "settings.sources.notify.remote"),
    },
  }
}
