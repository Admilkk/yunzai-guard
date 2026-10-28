import { useEffect, useRef, useState, type ReactNode } from "react"
import { Card, Tag, Tooltip } from "antd"
import { animate, useReducedMotion } from "motion/react"

const actions: Record<string, { label: string; color?: string }> = {
  audit: { label: "记录", color: "blue" },
  deny: { label: "拒绝", color: "red" },
  restart: { label: "重启", color: "orange" },
  info: { label: "系统" },
}

/** 动作标签；blocked 为 true 时标明已在入口拦截。 */
export function ActionTag({ action, blocked }: { action?: string; blocked?: boolean }) {
  const item = actions[action ?? ""] ?? { label: action || "—" }
  const tag = (
    <Tag color={item.color} className={blocked ? "action-tag blocked" : "action-tag"}>
      {item.label}
    </Tag>
  )
  return blocked ? <Tooltip title="已在调用入口拦截">{tag}</Tooltip> : tag
}

/** 带标题与操作区的卡片。 */
export function PanelCard({
  title,
  extra,
  children,
  className = "",
}: {
  title: ReactNode
  extra?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <Card className={`panel-card ${className}`} title={title} extra={extra}>
      {children}
    </Card>
  )
}

/** 指标卡片：标签、主数值与一行说明。 */
export function StatTile({
  label,
  value,
  note,
  tone,
  icon,
}: {
  label: string
  value: ReactNode
  note?: ReactNode
  tone?: "danger" | "warning" | "muted"
  icon?: ReactNode
}) {
  return (
    <div className={`stat-tile ${tone ? `stat-${tone}` : ""}`}>
      <span className="stat-label">
        {icon && <span className="stat-icon">{icon}</span>}
        {label}
      </span>
      <strong className="stat-value">{countable(value)}</strong>
      {note !== undefined && <span className="stat-note">{note}</span>}
    </div>
  )
}

/** 数字从上次的值滚动到新值。 */
export function CountUp({ value }: { value: number }) {
  const reduced = useReducedMotion()
  const [shown, setShown] = useState(reduced ? value : 0)
  const from = useRef(reduced ? value : 0)
  useEffect(() => {
    if (reduced) {
      setShown(value)
      return
    }
    const control = animate(from.current, value, {
      duration: 0.9,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: latest => {
        from.current = latest
        setShown(Math.round(latest))
      },
    })
    return () => control.stop()
  }, [value, reduced])
  return <>{shown.toLocaleString()}</>
}

/** 纯数字（含千分位）的统计值改为滚动显示，其余原样返回。 */
function countable(value: ReactNode): ReactNode {
  if (typeof value === "number") return <CountUp value={value} />
  if (typeof value === "string" && /^\d{1,3}(,\d{3})*$|^\d+$/.test(value))
    return <CountUp value={Number(value.replace(/,/g, ""))} />
  return value
}

/** 格式化时间，full 为 true 时包含年份与秒。 */
export function formatTime(value?: number, full = false) {
  if (!value) return "—"
  return new Intl.DateTimeFormat(
    "zh-CN",
    full
      ? {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }
      : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false },
  ).format(value)
}

/** 返回“刚刚 / N 分钟前”等相对时间，超过一天回退到日期。 */
export function relativeTime(value?: number, now = Date.now()) {
  if (!value) return "—"
  const seconds = Math.max(0, Math.round((now - value) / 1000))
  if (seconds < 45) return "刚刚"
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`
  return formatTime(value)
}

/** 把字节数格式化为 B/KiB/MiB/GiB。 */
export function formatBytes(value?: number) {
  if (value === undefined || !Number.isFinite(value)) return "—"
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit++
  }
  return `${size >= 100 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`
}

/** 取路径的最后一段文件名。 */
export function baseName(value: string) {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value
}

/** 返回阶段的中文名称。 */
export function phaseName(phase?: string) {
  return (
    (
      {
        online: "运行中",
        starting: "启动中",
        restarting: "重启中",
        stopping: "停止中",
        tripped: "已熔断",
        handoff: "接管中",
        backoff: "恢复中",
      } as Record<string, string>
    )[phase ?? ""] ||
    phase ||
    "离线"
  )
}
