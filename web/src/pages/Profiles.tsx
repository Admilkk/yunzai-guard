import { useCallback, useEffect, useState } from "react"
import {
  Alert,
  App,
  Button,
  Drawer,
  Empty,
  Popconfirm,
  Progress,
  Space,
  Table,
  Tag,
  Tooltip,
} from "antd"
import type { TableColumnsType } from "antd"
import { api } from "../api"
import { formatTime, PanelCard, relativeTime, StatTile } from "../components"
import { kindName } from "../lib/labels"

type Severity = "low" | "medium" | "high"
type Anomaly = {
  id: string
  time: number
  plugin: string
  type: "new-target" | "rate-spike" | "off-hours" | "burst"
  severity: Severity
  kind: string
  key: string
  detail: string
}
type Summary = {
  plugin: string
  startedAt: number
  learning: boolean
  learnEndsAt: number
  features: number
  total: number
  kinds: Record<string, number>
  risk: { score: number; level: Severity }
  anomalies7d: number
  lastAnomaly?: Anomaly
}
type Detail = {
  plugin: string
  learning: boolean
  risk: { score: number; level: Severity }
  total: number
  days: number
  hourly: number[]
  features: Array<{ kind: string; key: string; count: number; firstAt: number; lastAt: number }>
  anomalies: Anomaly[]
}

const severityTag: Record<Severity, { color: string; label: string }> = {
  low: { color: "default", label: "低" },
  medium: { color: "orange", label: "中" },
  high: { color: "red", label: "高" },
}
const anomalyName: Record<Anomaly["type"], string> = {
  "new-target": "新行为",
  "rate-spike": "频率突增",
  "off-hours": "非常规时段",
  burst: "批量新目标",
}
const riskColor: Record<Severity, string> = { low: "#6f9d90", medium: "#d4a24c", high: "#bd4f55" }

/** 24 小时活动分布。 */
function Hourly({ values }: { values: number[] }) {
  const maximum = Math.max(1, ...values)
  return (
    <div className="hourly-chart" role="img" aria-label="24 小时活动分布">
      {values.map((value, hour) => (
        <Tooltip key={hour} title={`${hour} 点 · ${value} 次`}>
          <span className="hourly-slot">
            <i style={{ height: `${Math.max(value ? 4 : 0, (value / maximum) * 100)}%` }} />
          </span>
        </Tooltip>
      ))}
      <div className="hourly-ticks">
        <span>0</span>
        <span>6</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
    </div>
  )
}

/** 行为画像页面：各插件的常规行为、风险分与异常。 */
export default function Profiles() {
  const { message } = App.useApp()
  const [data, setData] = useState<{ enabled: boolean; learnHours: number; plugins: Summary[] }>()
  const [selected, setSelected] = useState<string>()
  const [detail, setDetail] = useState<Detail>()

  const load = useCallback(async () => {
    try {
      setData(await api("/api/profiles"))
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "读取失败")
    }
  }, [message])

  const loadDetail = useCallback(async (plugin: string) => {
    try {
      setDetail(await api(`/api/profiles/detail?plugin=${encodeURIComponent(plugin)}`))
    } catch {
      setDetail(undefined)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 15000)
    return () => clearInterval(timer)
  }, [load])

  useEffect(() => {
    if (selected) void loadDetail(selected)
  }, [selected, loadDetail])

  /** 调用画像操作后刷新。 */
  async function act(
    action: "trust" | "forget" | "end" | "reset",
    body: Record<string, unknown> = {},
  ) {
    try {
      await api(`/api/profiles/${action}`, { method: "POST", body: JSON.stringify(body) })
      message.success("已更新")
      await load()
      if (selected) await loadDetail(selected)
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "操作失败")
    }
  }

  const plugins = data?.plugins ?? []
  const learning = plugins.filter(item => item.learning).length
  const high = plugins.filter(item => item.risk.level === "high").length
  const recent = plugins.reduce((sum, item) => sum + item.anomalies7d, 0)
  const columns: TableColumnsType<Summary> = [
    { title: "插件", dataIndex: "plugin", ellipsis: true },
    {
      title: "风险",
      dataIndex: "risk",
      width: 170,
      sorter: (a, b) => a.risk.score - b.risk.score,
      defaultSortOrder: "descend",
      render: (risk: Summary["risk"]) => (
        <Progress
          percent={risk.score}
          size="small"
          strokeColor={riskColor[risk.level]}
          format={value => `${value}`}
        />
      ),
    },
    {
      title: "状态",
      width: 130,
      render: (_, item) =>
        item.learning ? (
          <Tooltip title={`预计 ${formatTime(item.learnEndsAt)} 结束`}>
            <Tag color="blue">学习中</Tag>
          </Tooltip>
        ) : (
          <Tag color="green">监督中</Tag>
        ),
    },
    {
      title: "常规行为",
      width: 220,
      render: (_, item) => (
        <Space size={4} wrap>
          {Object.entries(item.kinds).map(([kind, count]) => (
            <Tag key={kind}>
              {kindName(kind)} {count}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: "近 7 天异常",
      dataIndex: "anomalies7d",
      width: 110,
      render: (value: number) =>
        value ? <b className="text-danger">{value}</b> : <span className="muted">0</span>,
    },
    {
      title: "最近异常",
      ellipsis: true,
      render: (_, item) =>
        item.lastAnomaly ? (
          <span>
            <Tag color={severityTag[item.lastAnomaly.severity].color}>
              {anomalyName[item.lastAnomaly.type]}
            </Tag>
            <span className="muted">{relativeTime(item.lastAnomaly.time)}</span>
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
  ]

  return (
    <div className="page-stack">
      {data && !data.enabled && (
        <Alert
          type="info"
          showIcon
          message="行为画像未启用"
          description="请在 系统设置 → 运行与监控 中开启"
        />
      )}
      <div className="stat-grid">
        <StatTile
          label="已建画像"
          value={plugins.length}
          note={`学习期 ${data?.learnHours ?? "—"} 小时`}
        />
        <StatTile label="学习中" value={learning} note="学习期内只记录不提示" />
        <StatTile
          label="高风险插件"
          value={high}
          tone={high ? "danger" : undefined}
          note="能力面广或近期异常多"
        />
        <StatTile
          label="近 7 天异常"
          value={recent}
          tone={recent ? "warning" : undefined}
          note="全部插件合计"
        />
        <StatTile
          label="操作"
          value={
            <Space size={6} wrap>
              <Button size="small" onClick={() => void act("end")} disabled={!learning}>
                全部结束学习
              </Button>
              <Popconfirm
                title="清空全部画像并重新学习？"
                onConfirm={() => void act("reset")}
                okText="清空"
                cancelText="取消"
              >
                <Button size="small" danger disabled={!plugins.length}>
                  全部重置
                </Button>
              </Popconfirm>
            </Space>
          }
        />
      </div>
      <PanelCard title="插件画像" className="table-card">
        <Table
          rowKey="plugin"
          size="middle"
          columns={columns}
          dataSource={plugins}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          locale={{
            emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有画像数据" />,
          }}
          onRow={item => ({ onClick: () => setSelected(item.plugin), className: "clickable-row" })}
          scroll={{ x: 860 }}
        />
      </PanelCard>
      <Drawer
        open={Boolean(selected)}
        onClose={() => {
          setSelected(undefined)
          setDetail(undefined)
        }}
        width={Math.min(720, innerWidth)}
        title={selected}
        extra={
          selected && (
            <Space>
              {detail?.learning && (
                <Button size="small" onClick={() => void act("end", { plugin: selected })}>
                  结束学习
                </Button>
              )}
              <Popconfirm
                title="清空该插件的画像并重新学习？"
                onConfirm={() => void act("reset", { plugin: selected })}
                okText="清空"
                cancelText="取消"
              >
                <Button size="small" danger>
                  重置
                </Button>
              </Popconfirm>
            </Space>
          )
        }
      >
        {detail ? (
          <div className="page-stack">
            <div className="profile-head">
              <Progress
                type="circle"
                size={76}
                percent={detail.risk.score}
                strokeColor={riskColor[detail.risk.level]}
                format={value => `${value}`}
              />
              <div>
                <strong>风险{severityTag[detail.risk.level].label}</strong>
                <span>
                  {detail.learning ? "学习中" : "监督中"} · 共 {detail.total} 次行为 · 活跃{" "}
                  {detail.days} 天
                </span>
              </div>
            </div>
            <PanelCard title="24 小时分布">
              <Hourly values={detail.hourly} />
            </PanelCard>
            <PanelCard title={`异常记录（${detail.anomalies.length}）`}>
              {detail.anomalies.length ? (
                <div className="anomaly-list">
                  {detail.anomalies.map(item => (
                    <div className="anomaly-item" key={item.id}>
                      <div>
                        <Tag color={severityTag[item.severity].color}>
                          {severityTag[item.severity].label}
                        </Tag>
                        <b>{anomalyName[item.type]}</b>
                        <span className="muted">
                          {" "}
                          · {kindName(item.kind)} · {formatTime(item.time)}
                        </span>
                      </div>
                      <p>{item.detail}</p>
                      {item.type === "new-target" && (
                        <Space size={6}>
                          <Button
                            size="small"
                            onClick={() =>
                              void act("trust", {
                                plugin: item.plugin,
                                kind: item.kind,
                                key: item.key,
                              })
                            }
                          >
                            信任此行为
                          </Button>
                          <Button
                            size="small"
                            type="link"
                            onClick={() =>
                              (location.hash = `plugins?plugin=${encodeURIComponent(item.plugin)}`)
                            }
                          >
                            去设置权限
                          </Button>
                        </Space>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有异常" />
              )}
            </PanelCard>
            <PanelCard title={`常规行为（${detail.features.length}）`} className="table-card">
              <Table<Detail["features"][number]>
                rowKey={item => `${item.kind}|${item.key}`}
                size="small"
                dataSource={detail.features}
                pagination={{ pageSize: 15, hideOnSinglePage: true }}
                columns={[
                  { title: "类型", dataIndex: "kind", width: 90, render: kindName },
                  { title: "对象", dataIndex: "key", ellipsis: true },
                  { title: "次数", dataIndex: "count", width: 70 },
                  {
                    title: "最近",
                    dataIndex: "lastAt",
                    width: 100,
                    render: value => relativeTime(value),
                  },
                  {
                    title: "",
                    width: 60,
                    render: (_, item) => (
                      <Tooltip title="移除后再次出现会重新提示">
                        <Button
                          size="small"
                          type="link"
                          danger
                          onClick={() =>
                            void act("forget", {
                              plugin: detail.plugin,
                              kind: item.kind,
                              key: item.key,
                            })
                          }
                        >
                          移除
                        </Button>
                      </Tooltip>
                    ),
                  },
                ]}
              />
            </PanelCard>
          </div>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Drawer>
    </div>
  )
}
