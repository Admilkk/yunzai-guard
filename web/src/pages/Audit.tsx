import { useEffect, useRef, useState } from "react"
import {
  App,
  Button,
  Descriptions,
  Input,
  Popover,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Dropdown,
} from "antd"
import type { InputRef, TableColumnsType } from "antd"
import {
  InfoCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  DownloadOutlined,
} from "@ant-design/icons"
import { api } from "../api"
import type { AuditEntry } from "../types"
import { ActionTag, formatTime, PanelCard } from "../components"
import { EventDetails, eventSource } from "../components/EventDetails"
import { functionName, kindName, operationName } from "../lib/labels"

type Filters = {
  plugin: string
  kind: string
  action: string
  q: string
  range: string
  system: boolean
}
const emptyFilters: Filters = { plugin: "", kind: "", action: "", q: "", range: "", system: false }
const actionLabels: Record<string, string> = {
  audit: "记录",
  deny: "拒绝",
  restart: "重启",
  info: "系统",
}
const ranges = [
  { value: "3600000", label: "1 小时" },
  { value: "86400000", label: "24 小时" },
  { value: "604800000", label: "7 天" },
  { value: "", label: "全部" },
]

/** 从地址栏 `#audit?kind=...` 读取初始筛选。 */
function filtersFromHash(): Filters {
  const at = location.hash.indexOf("?")
  const params = new URLSearchParams(at < 0 ? "" : location.hash.slice(at + 1))
  return {
    ...emptyFilters,
    plugin: params.get("plugin") ?? "",
    kind: params.get("kind") ?? "",
    action: params.get("action") ?? "",
    q: params.get("q") ?? "",
  }
}

/** 显示存储状态与读取范围。 */
function Coverage({ result }: { result: any }) {
  const coverage = result.coverage ?? {}
  const storage = result.storage?.engine === "sqlite" ? result.storage : undefined
  return (
    <Space size={8} wrap className="audit-coverage">
      <span className="result-total">
        <strong>{Number(result.total ?? 0).toLocaleString()}</strong> 条匹配
      </span>
      {storage && !storage.available && <Tag color="error">存储异常</Tag>}
      {coverage.truncated && <Tag color="orange">读取窗口已截断</Tag>}
      {coverage.lossReported && <Tag color="red">存在丢失报告</Tag>}
      {coverage.invalidLines > 0 && <Tag color="orange">无效记录 {coverage.invalidLines}</Tag>}
      {coverage.errors?.length > 0 && <Tag color="red">读取异常 {coverage.errors.length}</Tag>}
      <Popover
        trigger={["click"]}
        placement="bottomRight"
        content={
          <Descriptions
            column={1}
            size="small"
            className="coverage-descriptions"
            items={[
              { key: "engine", label: "存储", children: storage ? "SQLite" : "JSONL 日志" },
              {
                key: "records",
                label: "保留记录",
                children: `${Number(coverage.recordsRead ?? 0).toLocaleString()} 条`,
              },
              ...(storage
                ? [
                    {
                      key: "retained",
                      label: "占用",
                      children: `${(Number(storage.retainedBytes ?? 0) / 1048576).toFixed(2)} MiB`,
                    },
                    {
                      key: "evicted",
                      label: "已淘汰",
                      children: `${Number(storage.evictedRecords ?? 0).toLocaleString()} 条`,
                    },
                  ]
                : []),
              { key: "start", label: "最早", children: formatTime(coverage.windowStart, true) },
              { key: "end", label: "最新", children: formatTime(coverage.windowEnd, true) },
            ]}
          />
        }
      >
        <Button type="text" size="small" icon={<InfoCircleOutlined />} aria-label="存储详情" />
      </Popover>
    </Space>
  )
}

/** 行为审计页面。 */
export default function Audit() {
  const { message } = App.useApp()
  const [filters, setFilters] = useState<Filters>(filtersFromHash)
  const [search, setSearch] = useState(filters.q)
  const [page, setPage] = useState({ current: 1, size: 25 })
  const [result, setResult] = useState<any>({ items: [], total: 0, facets: {} })
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<AuditEntry | null>(null)
  const [live, setLive] = useState(false)
  const [tick, setTick] = useState(0)
  const searchRef = useRef<InputRef>(null)

  /** 修改筛选并回到第一页。 */
  const change = (next: Partial<Filters>) => {
    setFilters(previous => ({ ...previous, ...next }))
    setPage(previous => ({ ...previous, current: 1 }))
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      if (search !== filters.q) change({ q: search })
    }, 300)
    return () => clearTimeout(timer)
  }, [search, filters.q])

  useEffect(() => {
    const sync = () => {
      if (!location.hash.startsWith("#audit")) return
      const next = filtersFromHash()
      setFilters(next)
      setSearch(next.q)
      setPage(previous => ({ ...previous, current: 1 }))
    }
    addEventListener("hashchange", sync)
    const focus = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (event.key !== "/" || /input|textarea|select/i.test(target.tagName)) return
      event.preventDefault()
      searchRef.current?.focus()
    }
    addEventListener("keydown", focus)
    return () => {
      removeEventListener("hashchange", sync)
      removeEventListener("keydown", focus)
    }
  }, [])

  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setTick(value => value + 1), 10000)
    return () => clearInterval(timer)
  }, [live])

  /** 按当前筛选导出，最多 20000 条。 */
  async function exportAudit(format: "csv" | "json") {
    const params = new URLSearchParams({ format, limit: "20000" })
    for (const key of ["plugin", "kind", "action", "q"] as const)
      if (filters[key]) params.set(key, filters[key])
    if (filters.range) params.set("from", String(Date.now() - Number(filters.range)))
    if (!filters.system) params.set("scope", "behavior")
    try {
      const response = await fetch("/api/audit/export?" + params, { credentials: "same-origin" })
      if (!response.ok) throw new Error(`导出失败（${response.status}）`)
      const name =
        /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ??
        `guard-audit.${format}`
      const url = URL.createObjectURL(await response.blob())
      Object.assign(document.createElement("a"), { href: url, download: name }).click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "导出失败")
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    const params = new URLSearchParams({ page: String(page.current), pageSize: String(page.size) })
    for (const key of ["plugin", "kind", "action", "q"] as const)
      if (filters[key]) params.set(key, filters[key])
    if (filters.range) params.set("from", String(Date.now() - Number(filters.range)))
    if (!filters.system) params.set("scope", "behavior")
    api("/api/audit?" + params, { signal: controller.signal })
      .then(setResult)
      .catch((error: Error) => {
        if (error.name !== "AbortError") message.error(error.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [filters, page, tick, message])

  const active =
    filters.plugin || filters.kind || filters.action || filters.q || filters.range || filters.system
  const options = (key: string, first: string) => [
    { value: "", label: first },
    ...(result.facets?.[key] ?? [])
      .filter((value: string) => filters.system || (key === "actions" ? value !== "info" : true))
      .map((value: string) => ({
        value,
        label:
          key === "actions"
            ? (actionLabels[value] ?? value)
            : key === "plugins" && value === "unknown"
              ? "未知来源"
              : key === "kinds"
                ? kindName(value)
                : value,
      })),
  ]
  const columns: TableColumnsType<AuditEntry> = [
    {
      title: "时间",
      dataIndex: "time",
      width: 150,
      render: value => (
        <Tooltip title={formatTime(value, true)}>
          <span className="mono">{formatTime(value, true).slice(5)}</span>
        </Tooltip>
      ),
    },
    {
      title: "来源",
      dataIndex: "plugin",
      width: 150,
      ellipsis: true,
      render: (_, item) => (
        <button
          type="button"
          className="cell-filter"
          title="只看这个来源"
          onClick={event => {
            event.stopPropagation()
            change({ plugin: item.plugin })
          }}
        >
          {eventSource(item)}
        </button>
      ),
    },
    {
      title: "类型",
      dataIndex: "kind",
      width: 112,
      render: value => (
        <Tag
          className={`kind-tag kind-${value}`}
          onClick={event => {
            event.stopPropagation()
            change({ kind: value })
          }}
        >
          {kindName(value)}
        </Tag>
      ),
    },
    {
      title: "操作",
      dataIndex: "operation",
      width: 170,
      ellipsis: true,
      render: value => <Tooltip title={value}>{operationName(value)}</Tooltip>,
    },
    {
      title: "目标",
      dataIndex: "target",
      ellipsis: true,
      render: value => (
        <Tooltip title={value} placement="topLeft">
          <span className="target-cell">{functionName(value)}</span>
        </Tooltip>
      ),
    },
    {
      title: "处理",
      dataIndex: "action",
      width: 76,
      render: (value, item) => <ActionTag action={value} blocked={item.blocked} />,
    },
  ]
  return (
    <div className="page-stack">
      <div className="audit-toolbar">
        <Input
          ref={searchRef}
          aria-label="搜索事件"
          placeholder="搜索操作、目标或规则  /"
          prefix={<SearchOutlined />}
          allowClear
          value={search}
          onChange={event => setSearch(event.target.value)}
          className="audit-search"
        />
        <Select
          aria-label="来源"
          value={filters.plugin}
          options={options("plugins", "全部来源")}
          onChange={plugin => change({ plugin })}
          showSearch
          popupMatchSelectWidth={false}
          className="audit-select"
        />
        <Select
          aria-label="类型"
          value={filters.kind}
          options={options("kinds", "全部类型")}
          onChange={kind => change({ kind })}
          popupMatchSelectWidth={false}
          className="audit-select"
        />
        <Select
          aria-label="处理"
          value={filters.action}
          options={options("actions", "全部处理")}
          onChange={action => change({ action })}
          className="audit-select narrow"
        />
        <Segmented
          aria-label="时间范围"
          value={filters.range}
          options={ranges}
          onChange={range => change({ range: String(range) })}
        />
        <div className="audit-toolbar-end">
          <Dropdown
            menu={{
              items: [
                { key: "csv", label: "导出 CSV（表格软件可直接打开）" },
                { key: "json", label: "导出 JSON" },
              ],
              onClick: ({ key }) => void exportAudit(key as "csv" | "json"),
            }}
          >
            <Button size="small" icon={<DownloadOutlined />}>
              导出
            </Button>
          </Dropdown>
          <Tooltip title="包含面板登录、进程启动等宿主系统记录">
            <label className="inline-switch">
              <Switch
                size="small"
                checked={filters.system}
                onChange={system => change({ system })}
              />
              系统记录
            </label>
          </Tooltip>
          <Tooltip title="每 10 秒自动刷新">
            <label className="inline-switch">
              <Switch size="small" checked={live} onChange={setLive} />
              实时
            </label>
          </Tooltip>
          {active && (
            <Button
              type="link"
              size="small"
              onClick={() => {
                setFilters({ ...emptyFilters })
                setSearch("")
                setPage(previous => ({ ...previous, current: 1 }))
                if (location.hash.includes("?")) history.replaceState(null, "", "#audit")
              }}
            >
              清除筛选
            </Button>
          )}
          <Button
            aria-label="刷新审计"
            icon={<ReloadOutlined spin={loading} />}
            onClick={() => setTick(value => value + 1)}
          />
        </div>
      </div>
      <PanelCard title={<Coverage result={result} />} className="table-card audit-table-card">
        <Table
          rowKey="id"
          dataSource={result.items}
          columns={columns}
          loading={loading && !live}
          className="compact-table"
          scroll={{ x: 980 }}
          onRow={entry => ({
            onClick: () => setSelected(entry),
            tabIndex: 0,
            onKeyDown: event => {
              if (event.key === "Enter") setSelected(entry)
            },
            className: `clickable-row ${entry.blocked || entry.action === "deny" || entry.action === "restart" ? "row-blocked" : ""}`,
          })}
          pagination={{
            current: page.current,
            pageSize: page.size,
            total: result.total,
            showSizeChanger: true,
            pageSizeOptions: [25, 50, 100],
            showTotal: total => `${total.toLocaleString()} 条`,
            onChange: (current, size) =>
              setPage({ current: size === page.size ? current : 1, size }),
          }}
        />
      </PanelCard>
      <EventDetails entry={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
