import { useCallback, useEffect, useMemo, useState } from "react"
import { App, Button, Dropdown, Empty, Segmented, Space, Tag } from "antd"
import { BellOutlined, CheckOutlined, SettingOutlined } from "@ant-design/icons"
import { api } from "../api"
import { formatTime, PanelCard, relativeTime } from "../components"

type AlertRecord = {
  id: string
  muted?: boolean
  time: number
  category: string
  title: string
  text: string
  plugin?: string
  severity?: string
}

type AlertMute = { key: string; plugin?: string; category?: string; until: number }
type AlertState = { readBefore: number; read: string[]; mutes: AlertMute[] }

const muteOptions = [
  { minutes: 60, label: "1 小时" },
  { minutes: 24 * 60, label: "24 小时" },
  { minutes: 7 * 24 * 60, label: "7 天" },
]

const categoryTags: Record<string, { label: string; color: string }> = {
  deny: { label: "拦截", color: "red" },
  restart: { label: "重启", color: "volcano" },
  tripped: { label: "熔断", color: "magenta" },
  integrity: { label: "完整性", color: "purple" },
  anomaly: { label: "画像异常", color: "orange" },
  source: { label: "插件来源", color: "geekblue" },
  update: { label: "更新", color: "blue" },
  security: { label: "登录安全", color: "cyan" },
  digest: { label: "合并摘要", color: "default" },
}

/** 告警中心：最近发出的告警与 Webhook 测试。 */
export default function Alerts() {
  const { message } = App.useApp()
  const [history, setHistory] = useState<AlertRecord[]>([])
  const [filter, setFilter] = useState("all")
  const [testing, setTesting] = useState(false)
  const [state, setState] = useState<AlertState>({ readBefore: 0, read: [], mutes: [] })

  const load = useCallback(async () => {
    try {
      const [records, current] = await Promise.all([
        api("/api/alerts?limit=200"),
        api<AlertState>("/api/alerts/state"),
      ])
      setHistory(records.history ?? [])
      setState(current)
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "读取失败")
    }
  }, [message])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 10000)
    return () => clearInterval(timer)
  }, [load])

  /** 提交已读或静默操作，成功后用返回的状态刷新。 */
  async function mutate(path: string, body: Record<string, unknown>) {
    try {
      const result = await api<{ state: AlertState }>(path, {
        method: "POST",
        body: JSON.stringify(body),
      })
      setState(result.state)
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "操作失败")
    }
  }

  const unread = (item: AlertRecord) =>
    !item.muted && item.time > state.readBefore && !state.read.includes(item.id)

  /** 发送 Webhook 测试消息。 */
  async function testWebhook() {
    setTesting(true)
    try {
      const result = await api("/api/alerts/test", { method: "POST", body: "{}" })
      if (result.ok) message.success(`已发送，对方返回 ${result.status}`)
      else message.warning(result.error ?? `对方返回 ${result.status}`)
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "发送失败")
    } finally {
      setTesting(false)
    }
  }

  const categories = useMemo(() => [...new Set(history.map(item => item.category))], [history])
  const shown = filter === "all" ? history : history.filter(item => item.category === filter)
  const unreadCount = history.filter(unread).length

  return (
    <div className="page-stack">
      <PanelCard
        title="告警记录"
        className="alerts-card"
        extra={
          <Space size={8} wrap>
            <Button
              size="small"
              icon={<CheckOutlined />}
              disabled={!unreadCount}
              onClick={() => void mutate("/api/alerts/ack", {})}
            >
              全部已读{unreadCount ? `（${unreadCount}）` : ""}
            </Button>
            <Button size="small" loading={testing} onClick={() => void testWebhook()}>
              测试 Webhook
            </Button>
            <Button
              size="small"
              icon={<SettingOutlined />}
              onClick={() => (location.hash = "settings")}
            >
              告警设置
            </Button>
          </Space>
        }
      >
        {state.mutes.length > 0 && (
          <div className="alert-mutes">
            <span className="muted">静默中</span>
            {state.mutes.map(mute => (
              <Tag
                key={mute.key}
                closable
                onClose={event => {
                  event.preventDefault()
                  void mutate("/api/alerts/unmute", { key: mute.key })
                }}
              >
                {mute.plugin ?? categoryTags[mute.category ?? ""]?.label ?? mute.category} · 至{" "}
                {formatTime(mute.until)}
              </Tag>
            ))}
          </div>
        )}
        {categories.length > 1 && (
          <Segmented
            className="alerts-filter"
            size="small"
            value={filter}
            onChange={value => setFilter(String(value))}
            options={[
              { value: "all", label: "全部" },
              ...categories.map(value => ({ value, label: categoryTags[value]?.label ?? value })),
            ]}
          />
        )}
        {shown.length ? (
          <div className="alert-list">
            {shown.map((item, index) => (
              <div
                className={`alert-item${unread(item) ? " alert-unread" : ""}${item.muted ? " alert-muted" : ""}`}
                key={`${item.id}-${index}`}
              >
                <BellOutlined className="alert-icon" />
                <div className="alert-body">
                  <div className="alert-meta">
                    <Tag color={categoryTags[item.category]?.color}>
                      {categoryTags[item.category]?.label ?? item.category}
                    </Tag>
                    <span title={formatTime(item.time, true)}>{relativeTime(item.time)}</span>
                    {item.muted && <Tag>已静默</Tag>}
                  </div>
                  <p>{item.text.replace(/^【Yunzai Guard】/, "")}</p>
                </div>
                <Space size={4} className="alert-actions">
                  {unread(item) && (
                    <Button
                      size="small"
                      type="text"
                      onClick={() => void mutate("/api/alerts/ack", { ids: [item.id] })}
                    >
                      已读
                    </Button>
                  )}
                  <Dropdown
                    trigger={["click"]}
                    menu={{
                      items: muteOptions.flatMap(option => [
                        ...(item.plugin
                          ? [
                              {
                                key: `p-${option.minutes}`,
                                label: `静默 ${item.plugin} ${option.label}`,
                                onClick: () =>
                                  void mutate("/api/alerts/mute", {
                                    plugin: item.plugin,
                                    minutes: option.minutes,
                                  }),
                              },
                            ]
                          : []),
                        {
                          key: `c-${option.minutes}`,
                          label: `静默「${categoryTags[item.category]?.label ?? item.category}」${option.label}`,
                          onClick: () =>
                            void mutate("/api/alerts/mute", {
                              category: item.category,
                              minutes: option.minutes,
                            }),
                        },
                      ]),
                    }}
                  >
                    <Button size="small" type="text">
                      静默
                    </Button>
                  </Dropdown>
                </Space>
              </div>
            ))}
          </div>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="还没有告警。拦截、熔断、函数被改动、画像异常与插件来源变化都会出现在这里"
          />
        )}
      </PanelCard>
    </div>
  )
}
