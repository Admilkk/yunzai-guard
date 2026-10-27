import { useEffect, useMemo, useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  App,
  Button,
  Descriptions,
  Drawer,
  Flex,
  Form,
  Input,
  Popover,
  Select,
  Space,
  Table,
  Segmented,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd"
import type { TableProps } from "antd"
import { CloseOutlined, ReloadOutlined, SettingOutlined } from "@ant-design/icons"
import { useConsole } from "../state"
import { api } from "../api"
import type { AuditEntry, PluginPermission, PluginRecord } from "../types"
import { categories, nativeEntry, ownRule, setPermission } from "../lib/policy.js"
import { ActionTag, formatTime, PanelCard, relativeTime } from "../components"
import { EventDetails } from "../components/EventDetails"
import { NativeFields } from "./Advanced"
import { FieldLabel } from "../components/FieldHelp"
import { functionName, operationName } from "../lib/labels"

const actionLabel: Record<string, string> = {
  audit: "记录",
  deny: "拒绝",
  restart: "重启",
}
const actionOptions = [
  { value: "inherit", label: "继承" },
  { value: "audit", label: "记录" },
  { value: "deny", label: "拒绝" },
  { value: "restart", label: "重启" },
]
/** 判断是否为 Guard 自身。 */
const isGuard = (plugin: PluginRecord) => plugin.id.toLowerCase() === "yunzai-guard"
/** 判断插件能否单独配置权限。 */
const configurable = (plugin: PluginRecord) => !isGuard(plugin) && !/[*?]/.test(plugin.id)
/** 判断插件是否已启用独立沙箱。 */
const sandboxActive = (plugin: PluginRecord) => plugin.sandbox?.enabled === true

/** 显示权限评估所依据的示例事件。 */
function PermissionEvidence({
  plugin,
  permission,
}: {
  plugin: PluginRecord
  permission?: PluginPermission
}) {
  if (isGuard(plugin)) return <Tag>固定自保护</Tag>
  if (!permission) return <span className="muted">未采样</span>
  const source = permission.ruleId
    ? plugin.rules.find(rule => rule.id === permission.ruleId)
    : undefined
  return (
    <Popover
      trigger={["hover", "click"]}
      content={
        <Descriptions
          className="evidence-descriptions"
          column={1}
          size="small"
          items={[
            {
              key: "operation",
              label: "采样操作",
              children: operationName(permission.sample.operation),
            },
            { key: "target", label: "采样目标", children: functionName(permission.sample.target) },
            {
              key: "enforcement",
              label: "检查阶段",
              children: permission.enforcement === "after-change" ? "变化后" : "调用入口",
            },
            {
              key: "source",
              label: "规则来源",
              children: permission.ruleId
                ? `${source ? `第 ${source.index + 1} 条 · ` : ""}${permission.ruleId}`
                : "默认动作",
            },
          ]}
        />
      }
    >
      <Button type="text" size="small" className="evidence-button">
        <Space size={5} wrap>
          {permission.conditional && <Tag color="gold">按条件</Tag>}
          <span>{permission.ruleId ? "匹配规则" : "默认规则"}</span>
        </Space>
      </Button>
    </Popover>
  )
}

/** 插件权限页面。 */
export default function Plugins() {
  const ctx = useConsole()
  const { message } = App.useApp()
  const reduced = useReducedMotion()
  const [search, setSearch] = useState("")
  const [mode, setMode] = useState("all")
  const [selected, setSelected] = useState<string[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [tab, setTab] = useState("permissions")
  const [batch, setBatch] = useState(false)
  const [batchValues, setBatchValues] = useState<Record<string, string>>({})
  const [audit, setAudit] = useState<{ items: AuditEntry[]; total: number }>({
    items: [],
    total: 0,
  })
  const [auditPage, setAuditPage] = useState(1)
  const [auditLoading, setAuditLoading] = useState(false)
  const [event, setEvent] = useState<AuditEntry | null>(null)
  const current = ctx.plugins.find(plugin => plugin.id === currentId) ?? null
  const ids = selected.filter(id =>
    ctx.plugins.some(plugin => plugin.id === id && configurable(plugin)),
  )
  const visible = useMemo(
    () =>
      ctx.plugins.filter(plugin => {
        if (!plugin.id.toLowerCase().includes(search.trim().toLowerCase())) return false
        if (mode === "core") return plugin.reserved
        if (mode === "sandbox") return !plugin.reserved && sandboxActive(plugin)
        if (mode === "managed") return !plugin.reserved && !sandboxActive(plugin)
        return true
      }),
    [ctx.plugins, search, mode],
  )

  useEffect(() => {
    if (!currentId || tab !== "audit") return
    let cancelled = false
    setAuditLoading(true)
    api(`/api/audit?plugin=${encodeURIComponent(currentId)}&page=${auditPage}&pageSize=10`)
      .then(result => {
        if (!cancelled) setAudit(result)
      })
      .catch(error => {
        if (!cancelled) message.error(error.message)
      })
      .finally(() => {
        if (!cancelled) setAuditLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [currentId, tab, auditPage, message])

  const edit = (plugin: PluginRecord) => {
    setCurrentId(plugin.id)
    setTab("permissions")
    setAuditPage(1)
    setEvent(null)
    setAudit({ items: [], total: 0 })
  }
  const grant = (category: (typeof categories)[number], action: string) => {
    if (!current) return
    ctx.update(document => setPermission(document, current.id, category, action))
  }
  const applyBatch = () => {
    const updated = ctx.update(document => {
      for (const id of ids)
        for (const category of categories) {
          const value = batchValues[category.id]
          if (value && value !== "unchanged") setPermission(document, id, category, value)
        }
    })
    if (updated) {
      setBatchValues({})
      setBatch(false)
    }
  }
  const columns: TableProps<PluginRecord>["columns"] = [
    {
      title: "插件",
      dataIndex: "id",
      width: 260,
      render: (_, plugin) => {
        const active = sandboxActive(plugin)
        const draft = Boolean(nativeEntry(ctx.draft, plugin.id)?.enabled)
        return (
          <div className="plugin-cell">
            <Space size={6} wrap>
              <span className="plugin-name">{plugin.id}</span>
              {isGuard(plugin) ? (
                <Tag>自保护</Tag>
              ) : plugin.reserved ? (
                <Tag>内置</Tag>
              ) : active ? (
                <Tag color="blue">独立沙箱</Tag>
              ) : null}
              {configurable(plugin) && draft !== active && (
                <Tag color="gold">{draft ? "待启用沙箱" : "待停用沙箱"}</Tag>
              )}
            </Space>
            {plugin.description && <span className="plugin-description">{plugin.description}</span>}
          </div>
        )
      },
    },
    {
      title: "权限",
      render: (_, plugin) => {
        if (isGuard(plugin)) return <span className="muted">固定自保护</span>
        const chips = categories.flatMap(category => {
          const own = ownRule(ctx.draft.rules ?? [], plugin.id, category)
          const permission = plugin.permissions.find(item => item.id === category.id)
          const action = own?.action ?? permission?.action ?? "audit"
          if (action === "audit" && !own) return []
          const source = own
            ? "专属规则"
            : permission?.ruleId
              ? `全局规则 ${permission.ruleId}`
              : "默认"
          return [
            <Tooltip
              key={category.id}
              title={`${category.label}：${actionLabel[action]}（${source}）`}
            >
              <span className={`permission-chip chip-${action}`}>{category.short}</span>
            </Tooltip>,
          ]
        })
        return chips.length ? (
          <div className="permission-chips">{chips}</div>
        ) : (
          <span className="muted">全部记录</span>
        )
      },
    },
    {
      title: "事件",
      width: 90,
      align: "right",
      sorter: (a, b) => a.stats.total - b.stats.total,
      render: (_, plugin) =>
        plugin.stats.total ? plugin.stats.total.toLocaleString() : <span className="muted">0</span>,
    },
    {
      title: "拦截",
      width: 90,
      align: "right",
      sorter: (a, b) => a.stats.deny + a.stats.restart - (b.stats.deny + b.stats.restart),
      render: (_, plugin) => {
        const value = plugin.stats.deny + plugin.stats.restart
        return value ? (
          <Typography.Text type="danger">{value.toLocaleString()}</Typography.Text>
        ) : (
          <span className="muted">—</span>
        )
      },
    },
    {
      title: "最近活动",
      width: 120,
      sorter: (a, b) => (a.stats.lastEventAt ?? 0) - (b.stats.lastEventAt ?? 0),
      render: (_, plugin) => (
        <Tooltip title={formatTime(plugin.stats.lastEventAt, true)}>
          <span className="muted">{relativeTime(plugin.stats.lastEventAt)}</span>
        </Tooltip>
      ),
    },
    {
      title: "",
      key: "actions",
      width: 56,
      fixed: "end",
      render: (_, plugin) => (
        <Button
          type="text"
          aria-label={`${configurable(plugin) ? "配置" : "查看"} ${plugin.id}`}
          icon={<SettingOutlined />}
          onClick={event => {
            event.stopPropagation()
            edit(plugin)
          }}
        />
      ),
    },
  ]

  return (
    <div className="page-stack">
      <PanelCard className="table-card" title={<span className="card-title">插件列表</span>}>
        <div className="table-toolbar">
          <Space size={10} wrap>
            <Input
              aria-label="搜索插件"
              placeholder="搜索插件"
              allowClear
              value={search}
              onChange={event => setSearch(event.target.value)}
              className="filter-search"
            />
            <Select
              aria-label="当前运行方式"
              value={mode}
              className="filter-select"
              onChange={setMode}
              options={[
                { value: "all", label: "全部运行方式" },
                { value: "managed", label: "当前兼容托管" },
                { value: "sandbox", label: "当前独立沙箱" },
                { value: "core", label: "内置插件" },
              ]}
            />
          </Space>
          <Space size={8}>
            <span className="result-count">{visible.length} 个插件</span>
            <Button
              aria-label="刷新插件"
              icon={<ReloadOutlined />}
              disabled={ctx.saving}
              onClick={() => void ctx.reload().catch(error => message.error(error.message))}
              loading={ctx.loading}
            />
          </Space>
        </div>
        <AnimatePresence initial={false}>
          {ids.length > 0 && (
            <motion.div
              className="selection-toolbar-wrap"
              key="selection"
              initial={reduced ? false : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={{ duration: reduced ? 0 : 0.16 }}
            >
              <div className="selection-toolbar">
                <Typography.Text strong>已选 {ids.length} 项</Typography.Text>
                <Space size={8}>
                  <Button
                    type="primary"
                    disabled={ctx.saving}
                    onClick={() => {
                      setBatchValues({})
                      setBatch(true)
                    }}
                  >
                    批量权限
                  </Button>
                  <Button
                    aria-label="清空选择"
                    type="text"
                    icon={<CloseOutlined />}
                    onClick={() => setSelected([])}
                  />
                </Space>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <Table
          className="compact-table"
          rowKey="id"
          loading={ctx.loading}
          columns={columns}
          dataSource={visible}
          size="middle"
          scroll={{ x: 1040 }}
          pagination={{
            defaultPageSize: 12,
            showSizeChanger: true,
            pageSizeOptions: [12, 24, 50],
            showTotal: total => `${total} 项`,
          }}
          onRow={plugin => ({ onClick: () => edit(plugin), className: "clickable-row" })}
          rowSelection={{
            selectedRowKeys: ids,
            onChange: keys => setSelected(keys.map(String)),
            getCheckboxProps: plugin => ({
              disabled: !configurable(plugin) || ctx.saving,
              "aria-label": `选择 ${plugin.id}`,
            }),
          }}
        />
      </PanelCard>

      <Drawer
        title={current?.id}
        open={Boolean(current)}
        onClose={() => setCurrentId(null)}
        size={680}
        className="config-drawer"
        extra={
          current && (
            <Tag color={!current.reserved && sandboxActive(current) ? "blue" : undefined}>
              {isGuard(current)
                ? "固定自保护"
                : current.reserved
                  ? "内置插件"
                  : sandboxActive(current)
                    ? "当前独立沙箱"
                    : "当前兼容托管"}
            </Tag>
          )
        }
        footer={
          <Flex justify="end">
            <Button onClick={() => setCurrentId(null)}>返回</Button>
          </Flex>
        }
      >
        {current && (
          <motion.div
            key={current.id}
            initial={reduced ? false : { opacity: 0, x: 6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: reduced ? 0 : 0.15 }}
          >
            <Tabs
              activeKey={tab}
              onChange={setTab}
              items={[
                {
                  key: "permissions",
                  label: "单独权限",
                  children: (
                    <Table
                      rowKey="id"
                      size="small"
                      pagination={false}
                      scroll={{ x: 600 }}
                      className="permission-table"
                      dataSource={categories}
                      columns={[
                        {
                          title: "行为",
                          dataIndex: "label",
                          width: 125,
                          render: (value, category) => (
                            <FieldLabel helpKey={`permission.${category.id}`}>{value}</FieldLabel>
                          ),
                        },
                        {
                          title: <FieldLabel helpKey="rule.action">专属权限</FieldLabel>,
                          width: 250,
                          render: (_, category) => (
                            <Segmented
                              aria-label={category.label}
                              size="small"
                              className="permission-segmented"
                              disabled={!configurable(current) || ctx.saving}
                              options={actionOptions}
                              value={
                                ownRule(ctx.draft.rules ?? [], current.id, category)?.action ??
                                "inherit"
                              }
                              onChange={action => grant(category, String(action))}
                            />
                          ),
                        },
                        {
                          title: "已生效",
                          width: 80,
                          render: (_, category) => {
                            const permission = current.permissions.find(
                              item => item.id === category.id,
                            )
                            return isGuard(current) ? (
                              <ActionTag action="deny" />
                            ) : (
                              <ActionTag action={permission?.action ?? "audit"} />
                            )
                          },
                        },
                        {
                          title: "条件 / 来源",
                          render: (_, category) => (
                            <PermissionEvidence
                              plugin={current}
                              permission={current.permissions.find(item => item.id === category.id)}
                            />
                          ),
                        },
                      ]}
                    />
                  ),
                },
                { key: "sandbox", label: "独立沙箱", children: <NativeFields id={current.id} /> },
                {
                  key: "audit",
                  label: "近期事件",
                  children: (
                    <Table
                      rowKey="id"
                      size="small"
                      loading={auditLoading}
                      dataSource={audit.items}
                      scroll={{ x: 520 }}
                      pagination={{
                        current: auditPage,
                        pageSize: 10,
                        total: audit.total,
                        showSizeChanger: false,
                        onChange: setAuditPage,
                      }}
                      onRow={entry => ({
                        onClick: () => setEvent(entry),
                        className: "clickable-row",
                      })}
                      columns={[
                        {
                          title: "时间",
                          dataIndex: "time",
                          width: 150,
                          render: value => <span className="mono">{formatTime(value, true)}</span>,
                        },
                        {
                          title: "操作",
                          dataIndex: "operation",
                          ellipsis: true,
                          render: value => operationName(value),
                        },
                        {
                          title: "处理",
                          dataIndex: "action",
                          width: 80,
                          render: value => <ActionTag action={value} />,
                        },
                      ]}
                    />
                  ),
                },
              ]}
            />
          </motion.div>
        )}
      </Drawer>

      <Drawer
        title="批量权限"
        open={batch}
        onClose={() => setBatch(false)}
        size={460}
        className="config-drawer"
        extra={<Tag>{ids.length} 项</Tag>}
        footer={
          <Flex justify="end" gap={8}>
            <Button onClick={() => setBatch(false)}>返回</Button>
            <Button
              type="primary"
              disabled={
                ctx.saving ||
                !ids.length ||
                !Object.values(batchValues).some(value => value && value !== "unchanged")
              }
              onClick={applyBatch}
            >
              暂存更改
            </Button>
          </Flex>
        }
      >
        <Form layout="vertical" disabled={ctx.saving} className="batch-form">
          {categories.map(category => (
            <Form.Item
              key={category.id}
              label={
                <FieldLabel helpKey={`permission.${category.id}`}>{category.label}</FieldLabel>
              }
            >
              <Select
                aria-label={`批量${category.label}`}
                value={batchValues[category.id] ?? "unchanged"}
                options={[{ value: "unchanged", label: "保持不变" }, ...actionOptions]}
                onChange={value =>
                  setBatchValues(previous => ({ ...previous, [category.id]: value }))
                }
              />
            </Form.Item>
          ))}
        </Form>
      </Drawer>
      <EventDetails entry={event} onClose={() => setEvent(null)} />
    </div>
  )
}
