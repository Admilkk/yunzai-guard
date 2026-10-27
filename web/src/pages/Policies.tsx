import { useMemo, useState } from "react"
import { Button, Popconfirm, Segmented, Select, Space, Table, Tag } from "antd"
import type { TableProps } from "antd"
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
} from "@ant-design/icons"
import { useConsole } from "../state"
import type { Rule } from "../types"
import { ActionTag, PanelCard } from "../components"
import { RuleEditor } from "../components/RuleEditor"
import { functionName, kindName, operationName } from "../lib/labels"
import { ruleScenes } from "../lib/rules"
import { FieldLabel } from "../components/FieldHelp"

type IndexedRule = Rule & { index: number }

/** 全局规则页面。 */
export default function Policies() {
  const ctx = useConsole()
  const [scope, setScope] = useState("all")
  const [plugin, setPlugin] = useState<string | undefined>()
  const [editing, setEditing] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const [seed, setSeed] = useState<Partial<Rule>>()
  const rules = ctx.draft.rules ?? []
  const all = useMemo(() => rules.map((rule, index) => ({ ...rule, index })), [rules])
  const visible = all.filter(
    rule =>
      (scope === "all" ||
        (scope === "global"
          ? !rule.plugin || rule.plugin === "*"
          : Boolean(rule.plugin && rule.plugin !== "*"))) &&
      (!plugin || rule.plugin === plugin),
  )

  const edit = (index: number | null, scene?: Partial<Rule>) => {
    setEditing(index)
    setSeed(
      index === null
        ? { action: "audit", ...(scope === "plugin" && plugin ? { plugin } : {}), ...scene }
        : rules[index],
    )
    setOpen(true)
  }
  const move = (record: IndexedRule, step: number) => {
    const at = visible.findIndex(item => item.index === record.index)
    const target = visible[at + step]
    if (!target) return
    ctx.update(document => {
      const list = document.rules ?? []
      ;[list[record.index], list[target.index]] = [list[target.index], list[record.index]]
    })
  }
  const columns: TableProps<IndexedRule>["columns"] = [
    {
      title: "顺序",
      dataIndex: "index",
      width: 118,
      render: (index, record) => {
        const at = visible.findIndex(item => item.index === index)
        return (
          <div className="rule-order">
            <span className="rule-position">{index + 1}</span>
            <Button
              type="text"
              size="small"
              aria-label={`上移 ${record.id}`}
              disabled={at <= 0 || ctx.saving}
              icon={<ArrowUpOutlined />}
              onClick={() => move(record, -1)}
            />
            <Button
              type="text"
              size="small"
              aria-label={`下移 ${record.id}`}
              disabled={at < 0 || at === visible.length - 1 || ctx.saving}
              icon={<ArrowDownOutlined />}
              onClick={() => move(record, 1)}
            />
          </div>
        )
      },
    },
    {
      title: "匹配条件",
      key: "condition",
      render: (_, record) => {
        const kind = (Array.isArray(record.kind) ? record.kind : [record.kind || "*"])
          .map(kindName)
          .join("、")
        return (
          <div className="rule-condition">
            <Space size={8} wrap>
              <Tag>{kind}</Tag>
              <span className="mono">{operationName(record.operation || "*")}</span>
            </Space>
            <div className="rule-target">
              <span>目标</span>
              <span className="mono">
                {record.target ? functionName(record.target) : "全部目标"}
              </span>
            </div>
          </div>
        )
      },
    },
    {
      title: "插件",
      dataIndex: "plugin",
      width: 170,
      ellipsis: true,
      render: value => value || "全部插件",
    },
    {
      title: "处理",
      dataIndex: "action",
      width: 88,
      render: action => <ActionTag action={action} />,
    },
    {
      title: "",
      key: "actions",
      width: 92,
      fixed: "end",
      render: (_, record) => (
        <Space size={0}>
          <Button
            type="text"
            size="small"
            aria-label={`编辑 ${record.id}`}
            disabled={ctx.saving}
            icon={<EditOutlined />}
            onClick={() => edit(record.index)}
          />
          <Popconfirm
            title="删除这条规则？"
            okText="删除"
            cancelText="取消"
            onConfirm={() =>
              ctx.update(document => {
                document.rules?.splice(record.index, 1)
              })
            }
          >
            <Button
              type="text"
              size="small"
              danger
              disabled={ctx.saving}
              aria-label={`删除 ${record.id}`}
              icon={<DeleteOutlined />}
            />
          </Popconfirm>
        </Space>
      ),
    },
  ]
  return (
    <div className="page-stack">
      <PanelCard title="快捷创建" className="rule-quick-card">
        <div className="rule-scenes">
          {ruleScenes.map(scene => (
            <Button
              key={scene.id}
              disabled={ctx.saving || rules.length >= 1000}
              onClick={() =>
                edit(null, {
                  kind: scene.kind,
                  ...("operation" in scene ? { operation: scene.operation } : {}),
                })
              }
            >
              {scene.label}
            </Button>
          ))}
        </div>
      </PanelCard>
      <PanelCard
        className="table-card"
        title={<FieldLabel helpKey="rule.order">规则列表</FieldLabel>}
      >
        <div className="table-toolbar">
          <Space size={10} wrap>
            <Segmented
              aria-label="规则范围"
              value={scope}
              onChange={value => {
                setScope(value)
                setPlugin(undefined)
              }}
              options={[
                { value: "all", label: "全部" },
                { value: "global", label: "全局" },
                { value: "plugin", label: "插件" },
              ]}
            />
            <Select
              aria-label="筛选插件"
              className="filter-select filter-select-wide"
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="全部插件"
              value={plugin}
              onChange={setPlugin}
              options={ctx.plugins.map(item => ({ value: item.id, label: item.id }))}
              disabled={scope === "global"}
            />
          </Space>
          <Space size={10}>
            <span className="result-count">{visible.length} 条规则</span>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => edit(null)}
              disabled={ctx.saving || rules.length >= 1000}
            >
              新增规则
            </Button>
          </Space>
        </div>
        <Table
          rowKey={record => `${record.id}:${record.index}`}
          className="compact-table policy-table"
          columns={columns}
          dataSource={visible}
          size="middle"
          scroll={{ x: 830 }}
          pagination={{
            defaultPageSize: 15,
            showSizeChanger: true,
            pageSizeOptions: [15, 30, 50],
            showTotal: total => `${total} 项`,
          }}
        />
      </PanelCard>
      <RuleEditor
        open={open}
        seed={seed}
        editing={editing === null ? undefined : seed?.id}
        onClose={() => setOpen(false)}
      />
    </div>
  )
}
