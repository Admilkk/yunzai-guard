import { useCallback, useEffect, useMemo, useState } from "react"
import { App, Button, Empty, Segmented, Space, Tag } from "antd"
import { BellOutlined, SettingOutlined } from "@ant-design/icons"
import { api } from "../api"
import { formatTime, PanelCard, relativeTime } from "../components"

type AlertRecord = {
  time: number
  category: string
  title: string
  text: string
  plugin?: string
  severity?: string
}

const categoryTags: Record<string, { label: string; color: string }> = {
  deny: { label: "拦截", color: "red" },
  restart: { label: "重启", color: "volcano" },
  tripped: { label: "熔断", color: "magenta" },
  integrity: { label: "完整性", color: "purple" },
  anomaly: { label: "画像异常", color: "orange" },
  source: { label: "插件来源", color: "geekblue" },
  update: { label: "更新", color: "blue" },
  digest: { label: "合并摘要", color: "default" },
}

/** 告警中心：最近发出的告警与 Webhook 测试。 */
export default function Alerts() {
  const { message } = App.useApp()
  const [history, setHistory] = useState<AlertRecord[]>([])
  const [filter, setFilter] = useState("all")
  const [testing, setTesting] = useState(false)

  const load = useCallback(async () => {
    try {
      setHistory((await api("/api/alerts?limit=200")).history ?? [])
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "读取失败")
    }
  }, [message])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 10000)
    return () => clearInterval(timer)
  }, [load])

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

  return (
    <div className="page-stack">
      <PanelCard
        title="告警记录"
        className="alerts-card"
        extra={
          <Space size={8} wrap>
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
              <div className="alert-item" key={`${item.time}-${index}`}>
                <BellOutlined className="alert-icon" />
                <div>
                  <div className="alert-meta">
                    <Tag color={categoryTags[item.category]?.color}>
                      {categoryTags[item.category]?.label ?? item.category}
                    </Tag>
                    <span title={formatTime(item.time, true)}>{relativeTime(item.time)}</span>
                  </div>
                  <p>{item.text.replace(/^【Yunzai Guard】/, "")}</p>
                </div>
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
