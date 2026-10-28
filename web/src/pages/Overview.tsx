import { useEffect, useState } from "react"
import { Alert, App, Button, Collapse, Empty, Space, Table, Tag, Tooltip } from "antd"
import type { TableColumnsType } from "antd"
import {
  ApiOutlined,
  ArrowRightOutlined,
  AuditOutlined,
  GlobalOutlined,
  InboxOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
  WarningOutlined,
} from "@ant-design/icons"
import { api } from "../api"
import { useConsole } from "../state"
import { goTo } from "../navigation"
import {
  ActionTag,
  baseName,
  formatBytes,
  formatTime,
  PanelCard,
  phaseName,
  relativeTime,
  StatTile,
} from "../components"
import { EventDetails, eventSource } from "../components/EventDetails"
import { ResourceCard } from "../components/ResourceCard"
import { UpdateStrip } from "../components/UpdateStrip"
import { functionName, kindName, operationName } from "../lib/labels"
import type { AuditEntry } from "../types"

type Bucket = { time: number; total: number; deny?: number; restart?: number }
type Usage = {
  sampledAt: number
  processes: number
  readBytes: number
  writeBytes: number
  remote: string[]
  loopback: number
}
type NativeExtension = { plugin: string; target: string; lastAt: number; count: number }

/** 事件趋势柱状图：已拦截部分单独着色。 */
function Trend({ timeline }: { timeline: Bucket[] }) {
  if (!timeline.length)
    return (
      <Empty className="chart-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无事件" />
    )
  const maximum = Math.max(1, ...timeline.map(item => item.total))
  const ticks = [...new Set([0, Math.floor((timeline.length - 1) / 2), timeline.length - 1])]
  return (
    <div className="trend-chart" role="img" aria-label="事件趋势">
      <div className="trend-bars">
        {timeline.map(item => {
          const blocked = (item.deny ?? 0) + (item.restart ?? 0)
          return (
            <Tooltip
              key={item.time}
              title={`${formatTime(item.time)} · ${item.total} 条${blocked ? ` · 拦截 ${blocked}` : ""}`}
            >
              <div className="trend-slot">
                <div
                  className="trend-bar"
                  style={{
                    height: `${Math.max(item.total ? 3 : 0, (item.total / maximum) * 100)}%`,
                  }}
                >
                  {blocked > 0 && (
                    <span
                      className="trend-blocked"
                      style={{ height: `${(blocked / Math.max(1, item.total)) * 100}%` }}
                    />
                  )}
                </div>
              </div>
            </Tooltip>
          )
        })}
      </div>
      <div className="chart-ticks">
        {ticks.map(index => (
          <span key={index}>{formatTime(timeline[index].time)}</span>
        ))}
      </div>
    </div>
  )
}

const monitorStates: Record<string, { label: string; color?: string }> = {
  protected: { label: "正常", color: "green" },
  changed: { label: "已变化", color: "red" },
  pending: { label: "等待" },
  disabled: { label: "已停用" },
  "inspection-failed": { label: "检查失败", color: "red" },
  unreported: { label: "未报告" },
}

/** 系统层观察：进程树读写与外部连接。 */
function UsageCard({ usage, enabled }: { usage?: Usage; enabled: boolean }) {
  return (
    <PanelCard
      title="系统层观察"
      className="usage-card"
      extra={
        usage ? (
          <span className="result-count">{relativeTime(usage.sampledAt)}采样</span>
        ) : undefined
      }
    >
      {!usage ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={enabled ? "等待首次采样" : "已在运行设置中关闭"}
        />
      ) : (
        <>
          <div className="usage-grid">
            <div>
              <span>进程</span>
              <strong>{usage.processes}</strong>
            </div>
            <div>
              <span>累计读取</span>
              <strong>{formatBytes(usage.readBytes)}</strong>
            </div>
            <div>
              <span>累计写入</span>
              <strong>{formatBytes(usage.writeBytes)}</strong>
            </div>
            <div>
              <span>本机连接</span>
              <strong>{usage.loopback}</strong>
            </div>
          </div>
          <div className="usage-remote">
            <span className="usage-remote-title">外部连接 {usage.remote.length}</span>
            {usage.remote.length ? (
              <div className="usage-remote-list">
                {usage.remote.slice(0, 8).map(item => (
                  <code key={item}>{item}</code>
                ))}
                {usage.remote.length > 8 && (
                  <span className="muted">另有 {usage.remote.length - 8} 个</span>
                )}
              </div>
            ) : (
              <span className="muted">无外部连接</span>
            )}
          </div>
          <p className="card-footnote">系统层计数，含原生扩展；不区分插件，不能拦截。</p>
        </>
      )}
    </PanelCard>
  )
}

/** 原生扩展加载记录，兼容托管模式下提示启用系统隔离。 */
function NativeCard({ items, isolated }: { items: NativeExtension[]; isolated: boolean }) {
  return (
    <PanelCard title="原生扩展" className="native-card" extra={<Tag>{items.length}</Tag>}>
      {items.length && !isolated ? (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          className="native-alert"
          message="原生扩展不受 JS 层检查"
          description={<span>当前只记录加载。要限制，请开启系统隔离或添加原生扩展规则。</span>}
          action={
            <Button size="small" onClick={() => goTo("runtime")}>
              运行设置
            </Button>
          }
        />
      ) : null}
      {items.length ? (
        <div className="native-list">
          {items.slice(0, 6).map(item => (
            <div className="native-item" key={`${item.plugin}:${item.target}`}>
              <div>
                <strong>{baseName(item.target)}</strong>
                <span className="muted" title={item.target}>
                  {item.plugin === "unknown" ? "未知来源" : item.plugin}
                </span>
              </div>
              <span className="muted">{relativeTime(item.lastAt)}</span>
            </div>
          ))}
        </div>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无原生扩展" />
      )}
    </PanelCard>
  )
}

/** 概览页面。 */
export default function Overview() {
  const { overview, plugins, reload, dirty, saving, connected } = useConsole()
  const { message, modal } = App.useApp()
  const [recent, setRecent] = useState<AuditEntry[]>([])
  const [selected, setSelected] = useState<AuditEntry | null>(null)
  const status = overview?.status ?? {}
  const summary = overview?.audit?.summary ?? {}
  const buffer = status.auditPipeline?.buffer ?? {}
  const usage = status.usage as Usage | undefined
  const native = (overview?.native ?? []) as NativeExtension[]
  const isolated = overview?.active?.isolationMode === "os-sandbox"
  const online = connected && status.workerPid && status.phase === "online"

  useEffect(() => {
    let current = true
    api("/api/audit?pageSize=8&scope=behavior")
      .then(value => {
        if (current) setRecent(value.items ?? [])
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [overview])

  useEffect(() => {
    const timer = setInterval(() => {
      if (!dirty && !saving) void reload(true).catch(() => {})
    }, 15000)
    return () => clearInterval(timer)
  }, [dirty, saving, reload])

  /** 发送重启或解除熔断命令。 */
  async function command(name: "restart" | "resume") {
    try {
      await api(`/api/actions/${name}`, { method: "POST", body: "{}" })
      message.success(name === "restart" ? "已提交工作进程重启" : "已提交解除熔断")
      await reload(true)
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "操作失败")
    }
  }

  const blocked = Number(summary.deny ?? 0) + Number(summary.restart ?? 0)
  const business = plugins.filter(item => !item.reserved)
  const active = business.filter(item => item.stats.total > 0).length
  const kinds = Object.entries(summary.kinds ?? {})
    .filter(([kind]) => kind !== "system")
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 7)
  const kindMax = Math.max(1, ...kinds.map(item => Number(item[1])))
  const targets = status.monitoring?.targets ?? []
  const changed = targets.filter(
    (item: Record<string, any>) => item.state === "changed" || item.state === "inspection-failed",
  ).length
  const columns: TableColumnsType<AuditEntry> = [
    {
      title: "时间",
      dataIndex: "time",
      width: 92,
      render: time => (
        <Tooltip title={formatTime(time, true)}>
          <span className="muted">{relativeTime(time)}</span>
        </Tooltip>
      ),
    },
    {
      title: "来源",
      dataIndex: "plugin",
      width: 130,
      ellipsis: true,
      render: (_, entry) => eventSource(entry),
    },
    {
      title: "行为",
      dataIndex: "operation",
      ellipsis: true,
      render: (value, entry) => (
        <span title={entry.target}>
          {operationName(value)}
          <span className="row-target">{functionName(entry.target)}</span>
        </span>
      ),
    },
    {
      title: "处理",
      dataIndex: "action",
      width: 70,
      render: (action, entry) => <ActionTag action={action} blocked={entry.blocked} />,
    },
  ]

  return (
    <div className="page-stack overview-page">
      {status.trippedReason && (
        <Alert
          type="error"
          showIcon
          message="业务进程已熔断"
          description={`连续故障后已停止自动恢复：${status.trippedReason}。修正问题后点击“解除熔断”。`}
        />
      )}
      <section className="status-card">
        <div
          className="status-hero"
          data-state={online ? "success" : connected ? "warning" : "error"}
        >
          <div className="status-hero-main">
            <span className="status-pulse">
              {online ? <SafetyCertificateOutlined /> : <WarningOutlined />}
            </span>
            <div>
              <strong>
                {!connected
                  ? "宿主连接中断"
                  : status.workerPid
                    ? phaseName(status.phase)
                    : "业务未运行"}
              </strong>
              <span>
                第 {status.generation ?? "—"} 代 · {isolated ? "系统隔离" : "兼容托管"} · 宿主 PID{" "}
                <code>{status.hostPid ?? "—"}</code> · 业务 PID{" "}
                <code>{status.workerPid ?? "—"}</code>
              </span>
            </div>
          </div>
          <Space size={8} wrap>
            <Button
              danger
              icon={<ReloadOutlined />}
              disabled={!connected || saving}
              onClick={() =>
                modal.confirm({
                  title: "重启业务进程？",
                  content: "业务会短暂断开，控制台不受影响。",
                  okText: "重启",
                  cancelText: "取消",
                  onOk: () => command("restart"),
                })
              }
            >
              重启业务
            </Button>
            {status.trippedReason && (
              <Button
                type="primary"
                disabled={!connected || saving}
                onClick={() => command("resume")}
              >
                解除熔断
              </Button>
            )}
          </Space>
        </div>
        <UpdateStrip />
      </section>

      <div className="stat-grid">
        <StatTile
          label="已记录行为"
          value={Number(summary.total ?? 0)}
          icon={<AuditOutlined />}
          note={summary.unknownPlugin ? `${summary.unknownPlugin} 条来源不明` : undefined}
        />
        <StatTile
          label="已拦截"
          value={blocked}
          icon={<StopOutlined />}
          note={summary.restart ? `含 ${summary.restart} 次重启` : undefined}
          tone={blocked ? "danger" : undefined}
        />
        <StatTile
          label="活跃插件"
          value={
            <>
              {active}
              <small> / {business.length}</small>
            </>
          }
          icon={<ApiOutlined />}
        />
        <StatTile
          label="外部连接"
          value={usage ? usage.remote.length : "—"}
          icon={<GlobalOutlined />}
          note={usage ? `本机 ${usage.loopback}` : "未采样"}
          tone={usage ? undefined : "muted"}
        />
        <StatTile
          label="审计队列"
          value={Number(buffer.pendingRecords ?? 0)}
          icon={<InboxOutlined />}
          note={`丢弃 ${buffer.dropped ?? status.auditDropped ?? 0}`}
          tone={Number(buffer.dropped ?? status.auditDropped ?? 0) ? "warning" : undefined}
        />
      </div>

      <div className="overview-main-grid">
        <PanelCard
          title="事件趋势"
          extra={
            <Space size={12} className="legend">
              <span>
                <i className="legend-dot" />
                记录
              </span>
              <span>
                <i className="legend-dot blocked" />
                拦截
              </span>
            </Space>
          }
        >
          <Trend timeline={summary.timeline ?? []} />
        </PanelCard>
        <PanelCard title="行为类型">
          {kinds.length ? (
            <div className="kind-list">
              {kinds.map(([kind, value]) => (
                <button
                  type="button"
                  className="kind-item"
                  key={kind}
                  onClick={() => goTo("audit", `?kind=${encodeURIComponent(kind)}`)}
                >
                  <span>{kindName(kind)}</span>
                  <span className="kind-bar">
                    <i style={{ width: `${(Number(value) / kindMax) * 100}%` }} />
                  </span>
                  <b>{Number(value).toLocaleString()}</b>
                </button>
              ))}
            </div>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无事件" />
          )}
        </PanelCard>
      </div>

      <PanelCard
        title="最近行为"
        className="table-card"
        extra={
          <Button type="text" icon={<ArrowRightOutlined />} onClick={() => goTo("audit")}>
            全部
          </Button>
        }
      >
        <Table<AuditEntry>
          rowKey="id"
          columns={columns}
          dataSource={recent}
          pagination={false}
          size="middle"
          className="compact-table"
          onRow={entry => ({
            onClick: () => setSelected(entry),
            tabIndex: 0,
            onKeyDown: event => {
              if (event.key === "Enter") setSelected(entry)
            },
            className: "clickable-row",
          })}
          scroll={{ x: 520 }}
        />
      </PanelCard>

      <ResourceCard enabled={Boolean(overview?.active?.monitor?.process)} />

      <Collapse
        className="diagnostics-collapse"
        ghost
        items={[
          {
            key: "diagnostics",
            label: (
              <span className="diagnostics-label">
                运行诊断
                <span className="muted">原生扩展、系统观察与函数完整性</span>
              </span>
            ),
            children: (
              <div className="overview-diagnostics-grid">
                <NativeCard items={native} isolated={isolated} />
                <UsageCard usage={usage} enabled={overview?.active?.monitor?.process !== false} />
                <PanelCard
                  title="函数监控"
                  className="monitor-card"
                  extra={
                    changed ? (
                      <Tag color="red">{changed} 项异常</Tag>
                    ) : (
                      <Tag color="green">正常</Tag>
                    )
                  }
                >
                  {targets.length ? (
                    <div className="monitor-list">
                      {targets.map((item: Record<string, any>) => {
                        const state = monitorStates[item.state] ?? { label: item.state }
                        return (
                          <div className="monitor-item" key={item.target}>
                            <span title={item.target}>{functionName(item.target)}</span>
                            <Tag color={state.color}>{state.label}</Tag>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无监控目标" />
                  )}
                </PanelCard>
              </div>
            ),
          },
        ]}
      />
      <EventDetails entry={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
