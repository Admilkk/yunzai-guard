import { useEffect, useState } from "react"
import {
  Alert,
  Descriptions,
  Drawer,
  Empty,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
  Tag,
} from "antd"
import type { TableColumnsType } from "antd"
import { api, query } from "../api"
import { formatTime } from "../components"
import { functionName, kindName, operationName } from "../lib/labels"

type Stats = {
  from: number
  to: number
  total: number
  blocked: number
  kinds: Record<string, number>
  truncated: boolean
}
type Delta = { kind: string; operation: string; target: string; a: number; b: number }
type Comparison = {
  plugin?: string
  a: Stats
  b: Stats
  added: Delta[]
  removed: Delta[]
  changed: Delta[]
}

const periods = [
  { value: "3600000", label: "近 1 小时 vs 前 1 小时" },
  { value: "86400000", label: "近 24 小时 vs 前 24 小时" },
  { value: "604800000", label: "近 7 天 vs 前 7 天" },
]

/** 差异列表的列：类型、操作、目标与前后次数。 */
const columns: TableColumnsType<Delta> = [
  { title: "类型", dataIndex: "kind", width: 90, render: value => kindName(value) },
  { title: "行为", dataIndex: "operation", width: 130, render: value => operationName(value) },
  {
    title: "目标",
    dataIndex: "target",
    ellipsis: true,
    render: (value: string) => <span title={value}>{functionName(value)}</span>,
  },
  { title: "之前", dataIndex: "a", width: 70, align: "right" },
  { title: "现在", dataIndex: "b", width: 70, align: "right" },
]

/** 差异列表；为空时给出一句说明。 */
function DeltaTable({ title, items, empty }: { title: string; items: Delta[]; empty: string }) {
  return (
    <section className="compare-section">
      <h4>
        {title} <Tag>{items.length}</Tag>
      </h4>
      {items.length ? (
        <Table
          size="small"
          rowKey={item => `${item.kind}${item.operation}${item.target}`}
          dataSource={items}
          columns={columns}
          pagination={false}
          className="compact-table"
          scroll={{ x: 520 }}
        />
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty} />
      )}
    </section>
  )
}

/** 审计对比：同一插件（或全部插件）在两个相邻时间段的行为变化。 */
export function AuditCompare({
  open,
  plugins,
  initialPlugin,
  onClose,
}: {
  open: boolean
  plugins: string[]
  initialPlugin: string
  onClose: () => void
}) {
  const [period, setPeriod] = useState("86400000")
  const [plugin, setPlugin] = useState(initialPlugin)
  const [data, setData] = useState<Comparison>()
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) setPlugin(initialPlugin)
  }, [open, initialPlugin])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const span = Number(period)
    const now = Date.now()
    setLoading(true)
    setError("")
    api<Comparison>(
      `/api/audit/compare?${query({
        plugin,
        aFrom: now - 2 * span,
        aTo: now - span - 1,
        bFrom: now - span,
        bTo: now,
      })}`,
      { signal: controller.signal },
    )
      .then(setData)
      .catch((reason: Error) => {
        if (reason.name !== "AbortError") setError(reason.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [open, period, plugin])

  const kinds = data
    ? [...new Set([...Object.keys(data.a.kinds), ...Object.keys(data.b.kinds)])].sort()
    : []

  return (
    <Drawer
      title="行为对比"
      open={open}
      onClose={onClose}
      size="large"
      destroyOnHidden
      className="compare-drawer"
    >
      <Space direction="vertical" size={14} style={{ width: "100%" }}>
        <Space wrap>
          <Segmented
            size="small"
            value={period}
            onChange={value => setPeriod(String(value))}
            options={periods}
          />
          <Select
            size="small"
            showSearch
            value={plugin}
            onChange={setPlugin}
            style={{ minWidth: 160 }}
            options={[
              { value: "", label: "全部插件" },
              ...plugins.map(item => ({ value: item, label: item })),
            ]}
          />
        </Space>
        {error && <Alert type="error" showIcon title={error} />}
        <Spin spinning={loading}>
          {data && (
            <>
              <Descriptions
                size="small"
                column={2}
                bordered
                items={[
                  {
                    key: "a",
                    label: `之前（${formatTime(data.a.from)} 起）`,
                    children: `${data.a.total} 条 · 拦截 ${data.a.blocked}`,
                  },
                  {
                    key: "b",
                    label: `现在（${formatTime(data.b.from)} 起）`,
                    children: `${data.b.total} 条 · 拦截 ${data.b.blocked}`,
                  },
                  ...kinds.map(kind => ({
                    key: kind,
                    label: kindName(kind),
                    children: `${data.a.kinds[kind] ?? 0} → ${data.b.kinds[kind] ?? 0}`,
                  })),
                ]}
              />
              {(data.a.truncated || data.b.truncated) && (
                <Alert type="warning" showIcon title="事件很多，每个时间段只对比了较新的 5000 条" />
              )}
              <DeltaTable title="新出现的行为" items={data.added} empty="没有新增行为" />
              <DeltaTable title="不再出现的行为" items={data.removed} empty="没有消失的行为" />
              <DeltaTable title="次数明显变化" items={data.changed} empty="没有明显变化" />
              <p className="card-footnote">
                目标经过脱敏，只能对比脱敏后的文本；保留期之外的事件不在统计内。
              </p>
            </>
          )}
        </Spin>
      </Space>
    </Drawer>
  )
}
