import { useEffect, useState } from "react"
import { Empty, Progress } from "antd"
import { api } from "../api"
import { formatBytes, PanelCard, relativeTime } from "../components"

type Point = {
  time: number
  processes: number
  rssBytes: number
  cpu: number
  readBytesPerSecond: number
  writeBytesPerSecond: number
  connections: number
  hostRssBytes: number
  hostLagMs: number
}
type Resources = {
  points: Point[]
  system: {
    platform: string
    totalMemory: number
    freeMemory: number
    cpus: number
    load: number[]
    uptime: number
  }
  host: { pid: number; rss: number; heapUsed: number; heapTotal: number; uptime: number }
}

/** 折线缩略图：无坐标轴，只看走势。 */
function Spark({ values, tone = "primary" }: { values: number[]; tone?: "primary" | "warning" }) {
  if (values.length < 2) return <div className="spark spark-empty">采集中</div>
  const max = Math.max(...values, 1e-9)
  const width = 100
  const height = 28
  const step = width / (values.length - 1)
  const line = values
    .map(
      (value, index) =>
        `${(index * step).toFixed(2)},${(height - (value / max) * (height - 3) - 1.5).toFixed(2)}`,
    )
    .join(" ")
  return (
    <svg
      className={`spark spark-${tone}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <polygon points={`0,${height} ${line} ${width},${height}`} className="spark-area" />
      <polyline points={line} className="spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** 占比超过 90% 时进度条转为警示色。 */
const level = (ratio: number): "normal" | "exception" => (ratio >= 0.9 ? "exception" : "normal")

/** 内存与资源：整机、业务进程与宿主的内存和 CPU，附最近一段时间的走势。 */
export function ResourceCard({ enabled }: { enabled: boolean }) {
  const [data, setData] = useState<Resources>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    const load = () =>
      api<Resources>("/api/resources")
        .then(value => {
          if (!alive) return
          setData(value)
          setFailed(false)
        })
        .catch(() => alive && setFailed(true))
    void load()
    const timer = setInterval(() => void load(), 10000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const latest = data?.points.at(-1)
  const system = data?.system
  const used = system ? system.totalMemory - system.freeMemory : 0
  const usedRatio = system ? used / system.totalMemory : 0
  const workerRatio = system && latest ? latest.rssBytes / system.totalMemory : 0
  const points = data?.points ?? []

  return (
    <PanelCard
      title="内存与资源"
      className="resource-card"
      extra={
        latest ? <span className="result-count">{relativeTime(latest.time)}采样</span> : undefined
      }
    >
      {!data || !system ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={failed ? "资源数据读取失败" : "读取中"}
        />
      ) : (
        <>
          <div className="resource-grid">
            <div className="resource-tile resource-main">
              <span className="resource-label">整机内存</span>
              <strong className="resource-value">{formatBytes(used)}</strong>
              <span className="resource-note">共 {formatBytes(system.totalMemory)}</span>
              <Progress
                percent={Math.round(usedRatio * 100)}
                size="small"
                status={level(usedRatio)}
                showInfo={false}
              />
            </div>
            <div className="resource-tile resource-main">
              <span className="resource-label">业务进程内存</span>
              <strong className="resource-value">
                {latest ? formatBytes(latest.rssBytes) : enabled ? "采集中" : "未启用"}
              </strong>
              <span className="resource-note">
                {latest
                  ? `${latest.processes} 个进程 · 占整机 ${(workerRatio * 100).toFixed(1)}%`
                  : "—"}
              </span>
              <Progress
                percent={Math.round(workerRatio * 100)}
                size="small"
                status={level(workerRatio)}
                showInfo={false}
              />
              <Spark values={points.map(item => item.rssBytes)} />
            </div>
            <div className="resource-tile">
              <span className="resource-label">业务 CPU</span>
              <strong className="resource-value">
                {latest ? `${(Math.min(latest.cpu / system.cpus, 1) * 100).toFixed(1)}%` : "—"}
              </strong>
              <span className="resource-note">
                {latest
                  ? `${latest.cpu.toFixed(2)} 核 / 共 ${system.cpus} 核`
                  : `共 ${system.cpus} 核`}
              </span>
              <Spark values={points.map(item => item.cpu)} />
            </div>
            <div className="resource-tile">
              <span className="resource-label">Guard 宿主内存</span>
              <strong className="resource-value">{formatBytes(data.host.rss)}</strong>
              <span className="resource-note">
                堆 {formatBytes(data.host.heapUsed)} · 延迟 {(latest?.hostLagMs ?? 0).toFixed(1)} ms
              </span>
              <Spark values={points.map(item => item.hostRssBytes)} tone="warning" />
            </div>
          </div>
          {system.load.some(Boolean) && (
            <p className="card-footnote">
              系统负载 {system.load.map(value => value.toFixed(2)).join(" / ")}
            </p>
          )}
        </>
      )}
    </PanelCard>
  )
}
