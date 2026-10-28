import { useEffect, useMemo, useState } from "react"
import {
  Alert,
  App,
  Button,
  Collapse,
  Descriptions,
  Drawer,
  Flex,
  Form,
  Input,
  Segmented,
  Select,
  Space,
  Tag,
} from "antd"
import { useConsole } from "../state"
import { api } from "../api"
import type { AuditEntry, Rule } from "../types"
import { newRuleId } from "../lib/id"
import {
  actionName,
  functionName,
  kindName,
  kindNames,
  operationName,
  operationNames,
} from "../lib/labels"
import { canCreateRule, eventRule, matchingRules, needsTarget, ruleScenes } from "../lib/rules"
import { FieldLabel } from "./FieldHelp"
import { rule as validateRule } from "../../../src/config/validation.js"

interface Values {
  id: string
  action: Rule["action"]
  kind: string[]
  scope: "all" | "plugin" | "pattern"
  plugin?: string
  operation?: string
  target?: string
  position: "first" | "last"
}

/** 把表单值转为规则。 */
function toRule(value: Values): Rule {
  const rule: Rule = { id: value.id?.trim() ?? "", action: value.action ?? "audit" }
  if (value.kind?.length && !value.kind.includes("*"))
    rule.kind = value.kind.length === 1 ? value.kind[0] : value.kind
  if (value.scope !== "all" && value.plugin?.trim()) rule.plugin = value.plugin.trim()
  if (value.operation?.trim() && value.operation !== "*") rule.operation = value.operation.trim()
  if (value.target?.trim()) rule.target = value.target.trim()
  return rule
}

/** 规则编辑器，显示匹配预览与近期命中。 */
const replayRanges = [
  { value: "recent", label: "最近 100 条", hours: 0 },
  { value: "1h", label: "近 1 小时", hours: 1 },
  { value: "24h", label: "近 24 小时", hours: 24 },
  { value: "7d", label: "近 7 天", hours: 168 },
]

export function RuleEditor({
  open,
  seed,
  editing,
  sample,
  onClose,
}: {
  open: boolean
  seed?: Partial<Rule>
  editing?: string
  sample?: AuditEntry
  onClose: () => void
}) {
  const ctx = useConsole()
  const { message, modal } = App.useApp()
  const [form] = Form.useForm<Values>()
  const values = Form.useWatch([], { form, preserve: true }) as Values | undefined
  const [samples, setSamples] = useState<AuditEntry[]>([])
  const [sampleError, setSampleError] = useState(false)
  const [range, setRange] = useState("recent")
  const [truncated, setTruncated] = useState(false)
  const [changed, setChanged] = useState(false)
  const [customOperation, setCustomOperation] = useState(false)
  const [customTarget, setCustomTarget] = useState(false)
  useEffect(() => {
    if (!open) return
    form.resetFields()
    form.setFieldsValue({
      id: seed?.id ?? newRuleId(),
      action: seed?.action ?? "audit",
      kind:
        typeof seed?.kind === "string" ? [seed.kind] : (seed?.kind ?? [editing ? "*" : "network"]),
      scope:
        !seed?.plugin || seed.plugin === "*"
          ? "all"
          : /[*?]/.test(seed.plugin)
            ? "pattern"
            : "plugin",
      plugin: seed?.plugin,
      operation: seed?.operation,
      target: seed?.target,
      position: "first",
    })
    setChanged(false)
    setCustomOperation(Boolean(seed?.operation && !operationNames[seed.operation]))
    setCustomTarget(
      Boolean(seed?.target && !ctx.overview?.defaults?.protectTargets?.includes(seed.target)),
    )
    setRange("recent")
  }, [open, seed, editing, form])

  /** 按所选时间范围读取回放样本：默认最近 100 条，其余分页读取至多 2000 条。 */
  useEffect(() => {
    if (!open) return
    setSamples(sample ? [sample] : [])
    setSampleError(false)
    setTruncated(false)
    const controller = new AbortController()
    const hours = replayRanges.find(item => item.value === range)?.hours
    const since = hours ? Date.now() - hours * 3600_000 : undefined
    ;(async () => {
      const collected: AuditEntry[] = []
      let more = true
      for (let page = 1; more && page <= (since ? 20 : 1); page++) {
        const result = await api(
          `/api/audit?pageSize=100&page=${page}&scope=behavior${since ? `&from=${since}` : ""}`,
          { signal: controller.signal },
        )
        collected.push(...(result.items ?? []))
        more = Boolean(since && result.hasMore)
        if (!more) break
        if (page === 20) setTruncated(true)
      }
      if (controller.signal.aborted) return
      const entries = collected.filter(canCreateRule)
      setSamples(
        sample && !entries.some(entry => entry.id === sample.id) ? [sample, ...entries] : entries,
      )
    })().catch((error: Error) => {
      if (error.name !== "AbortError") setSampleError(true)
    })
    return () => controller.abort()
  }, [open, sample, range])

  const rule = useMemo(() => (values ? toRule(values) : undefined), [values])
  const rules = ctx.draft.rules ?? []
  const candidate = useMemo(() => {
    if (!open || !rule) return []
    if (editing) return rules.map(item => (item.id === editing ? rule : item))
    return values?.position === "last" ? [...rules, rule] : [rule, ...rules]
  }, [open, rule, rules, editing, values?.position])
  const matches = useMemo(
    () => (open && rule ? matchingRules(rule, candidate, samples) : []),
    [open, rule, candidate, samples],
  )
  const confirmed = matches.filter(item => !item.uncertain)
  const effective = confirmed.filter(item => item.first === rule?.id)
  const byPlugin = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of effective)
      counts.set(item.entry.plugin, (counts.get(item.entry.plugin) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6)
  }, [effective])
  const kinds = values?.kind ?? []
  const targetRequired = Boolean(
    sample &&
    kinds.includes(sample.kind) &&
    values?.operation === sample.operation &&
    needsTarget(sample),
  )
  const siteTarget = Boolean(
    sample?.target.includes("[path-redacted]") &&
    values?.target === eventRule(sample).target &&
    kinds.includes(sample.kind),
  )
  const afterChange = kinds.includes("integrity") && values?.operation !== "native.hook"
  const defaultFunctions: string[] = ctx.overview?.defaults?.protectTargets ?? []
  const targetPlaceholder = kinds.includes("network")
    ? "https://api.example.com/*"
    : kinds.includes("integrity")
      ? "选择核心函数或填写路径"
      : kinds.includes("process")
        ? "程序路径或命令，留空匹配全部"
        : "留空匹配全部目标"
  const pluginOptions = ctx.plugins.map(item => ({ value: item.id, label: item.id }))
  if (values?.plugin && !pluginOptions.some(item => item.value === values.plugin))
    pluginOptions.push({
      value: values.plugin,
      label: values.plugin === "unknown" ? "未知来源" : values.plugin,
    })
  const operationOptions = Object.entries(operationNames)
    .filter(([value]) => {
      if (value === "*" || value === values?.operation) return true
      return kinds.some(kind =>
        kind === "network"
          ? /^(fetch|request|connect|http\.|https\.|net\.|Socket\.|tls\.|udp\.)/.test(value)
          : kind === "process" || kind === "worker"
            ? /^(exec|spawn|fork|worker$)/.test(value)
            : kind === "plugin"
              ? value.startsWith("plugin.")
              : kind === "integrity"
                ? /^(protected-target-|module-function-|plugin-function-|native\.hook)/.test(value)
                : kind === "*",
      )
    })
    .map(([value, label]) => ({ value, label }))
  const close = () => {
    if (!changed) return onClose()
    modal.confirm({
      title: "放弃未添加的规则？",
      okText: "放弃",
      cancelText: "继续编辑",
      onOk: onClose,
    })
  }
  const save = async () => {
    try {
      await form.validateFields()
      const fields = form.getFieldsValue(true) as Values
      const next = validateRule(toRule(fields), "rule")
      if (rules.some(item => item.id === next.id && item.id !== editing)) {
        message.error("规则名称重复")
        return
      }
      if (editing && !rules.some(item => item.id === editing)) {
        message.error("原规则已被移除")
        return
      }
      if (!editing && rules.length >= 1000) {
        message.error("最多 1000 条规则")
        return
      }
      if (
        ctx.update(document => {
          const list = (document.rules ??= [])
          if (editing)
            list.splice(
              list.findIndex(item => item.id === editing),
              1,
              next,
            )
          else if (fields.position === "last") list.push(next)
          else list.unshift(next)
        })
      )
        onClose()
    } catch (error) {
      if (!(error as { errorFields?: unknown }).errorFields) message.error((error as Error).message)
    }
  }
  return (
    <Drawer
      title={editing ? "编辑规则" : sample ? "从事件创建规则" : "创建规则"}
      open={open}
      onClose={close}
      size={580}
      styles={{ wrapper: { width: "min(580px, 100vw)", maxWidth: "100vw" } }}
      className="config-drawer rule-editor"
      footer={
        <Flex justify="end" gap={8}>
          <Button onClick={close}>取消</Button>
          <Button type="primary" onClick={save} disabled={ctx.saving}>
            {editing ? "更新到草稿" : "添加到草稿"}
          </Button>
        </Flex>
      }
    >
      <Form
        form={form}
        layout="vertical"
        className="drawer-form"
        disabled={ctx.saving}
        onValuesChange={() => setChanged(true)}
      >
        <div className="rule-scenes">
          {ruleScenes.map(scene => (
            <Button
              key={scene.id}
              size="small"
              type={
                kinds.length === 1 &&
                kinds[0] === scene.kind &&
                (values?.operation ?? "") === ("operation" in scene ? scene.operation : "")
                  ? "primary"
                  : "default"
              }
              onClick={() => {
                form.setFieldsValue({
                  kind: [scene.kind],
                  operation: "operation" in scene ? scene.operation : undefined,
                  target: undefined,
                })
                setCustomOperation(false)
                setCustomTarget(false)
                setChanged(true)
              }}
            >
              {scene.label}
            </Button>
          ))}
        </div>
        <Form.Item label="作用范围" name="scope">
          <Select
            aria-label="规则作用范围"
            options={[
              { value: "plugin", label: "指定插件" },
              { value: "all", label: "全部插件" },
              { value: "pattern", label: "按插件名匹配" },
            ]}
            onChange={() => form.setFieldValue("plugin", undefined)}
          />
        </Form.Item>
        {values?.scope !== "all" && (
          <Form.Item
            label="插件"
            name="plugin"
            rules={[
              { required: true, whitespace: true, message: "选择插件" },
              { max: 512, message: "最多 512 个字符" },
            ]}
          >
            {values?.scope === "pattern" ? (
              <Input aria-label="插件名称模式" placeholder="例如 example-*" maxLength={512} />
            ) : (
              <Select
                aria-label="规则插件"
                showSearch
                optionFilterProp="label"
                options={pluginOptions}
                placeholder="选择插件"
              />
            )}
          </Form.Item>
        )}
        <Form.Item
          label={<FieldLabel helpKey="rule.kind">监控行为</FieldLabel>}
          name="kind"
          extra={
            !kinds.length || kinds.includes("*")
              ? "全部行为不含文件访问、原生扩展和端口监听，需要时请单独选择。"
              : undefined
          }
          rules={[
            {
              validator: (_, list: string[]) =>
                !list ||
                (list.length <= 32 &&
                  list.every(item => item && item.length <= 100 && !/[\0\r\n]/.test(item)))
                  ? Promise.resolve()
                  : Promise.reject(new Error("最多 32 个类型，每项不超过 100 字符")),
            },
          ]}
        >
          <Select
            aria-label="规则类型"
            mode="multiple"
            maxCount={32}
            maxTagCount="responsive"
            placeholder="全部行为"
            onChange={next => {
              if (next.includes("*") && next.length > 1)
                form.setFieldValue(
                  "kind",
                  kinds.includes("*") ? next.filter((value: string) => value !== "*") : ["*"],
                )
            }}
            options={[
              ...new Set([
                ...Object.keys(kindNames).filter(
                  value =>
                    !["system", "coverage", "guard", "runtime", "self-protection"].includes(value),
                ),
                ...kinds,
              ]),
            ].map(value => ({ value, label: kindName(value) }))}
          />
        </Form.Item>
        <Form.Item
          label={
            <Flex justify="space-between">
              <FieldLabel helpKey="rule.operation">具体操作</FieldLabel>
              <Button size="small" type="link" onClick={() => setCustomOperation(value => !value)}>
                {customOperation ? "选择操作" : "自定义"}
              </Button>
            </Flex>
          }
          name="operation"
          rules={[
            { max: 512, message: "最多 512 个字符" },
            { pattern: /^[^\0\r\n]*$/, message: "不能包含换行或空字符" },
          ]}
        >
          {customOperation ? (
            <Input aria-label="自定义规则操作" placeholder="例如 exec*" maxLength={512} />
          ) : (
            <Select
              aria-label="规则操作"
              showSearch
              optionFilterProp="label"
              allowClear
              placeholder="全部操作"
              options={operationOptions}
            />
          )}
        </Form.Item>
        <Form.Item
          label={
            <FieldLabel
              help={
                siteTarget
                  ? { description: "原始路径已脱敏，当前按整个站点匹配。" }
                  : targetRequired
                    ? { description: "原始目标或命令参数已脱敏，请填写匹配模式。" }
                    : undefined
              }
              helpKey="rule.target"
            >
              匹配目标
            </FieldLabel>
          }
          name="target"
          rules={[
            {
              required: targetRequired,
              whitespace: true,
              message: "原始目标已脱敏，请填写匹配模式",
            },
            { max: 512, message: "最多 512 个字符" },
            { pattern: /^[^\0\r\n]*$/, message: "不能包含换行或空字符" },
          ]}
        >
          {kinds.includes("integrity") && !customTarget ? (
            <Select
              aria-label="规则目标"
              showSearch
              allowClear
              optionFilterProp="label"
              placeholder={targetPlaceholder}
              options={[
                ...new Set([...defaultFunctions, ...(values?.target ? [values.target] : [])]),
              ].map(value => ({ value, label: functionName(value) }))}
              popupRender={menu => (
                <>
                  {menu}
                  <Button type="text" block onClick={() => setCustomTarget(true)}>
                    使用自定义路径
                  </Button>
                </>
              )}
            />
          ) : (
            <Input aria-label="规则目标" placeholder={targetPlaceholder} maxLength={512} />
          )}
        </Form.Item>
        <Form.Item
          label={
            <FieldLabel
              help={
                afterChange
                  ? { description: "函数修改可能在发生后才被发现，拒绝无法撤销已有修改。" }
                  : undefined
              }
              helpKey="rule.action"
            >
              处理方式
            </FieldLabel>
          }
          name="action"
          rules={[{ required: true }]}
        >
          <Select
            aria-label="规则动作"
            options={[
              { value: "audit", label: "记录并放行" },
              {
                value: "deny",
                label: "拒绝执行",
                disabled: afterChange && seed?.action !== "deny",
              },
              { value: "restart", label: "重启业务进程" },
            ]}
          />
        </Form.Item>
        {!editing && (
          <Form.Item label={<FieldLabel helpKey="rule.order">匹配顺序</FieldLabel>} name="position">
            <Select
              aria-label="规则匹配顺序"
              options={[
                { value: "first", label: "优先匹配" },
                { value: "last", label: "最后匹配" },
              ]}
            />
          </Form.Item>
        )}
        <div className="rule-preview">
          <Descriptions
            size="small"
            column={1}
            items={[
              {
                key: "scope",
                label: "范围",
                children: values?.scope === "all" ? "全部插件" : values?.plugin || "尚未选择插件",
              },
              {
                key: "behavior",
                label: "行为",
                children: `${kinds.length ? kinds.map(kindName).join("、") : "全部行为"} · ${operationName(values?.operation || "*")}`,
              },
              {
                key: "target",
                label: "目标",
                children: values?.target ? functionName(values.target) : "全部目标",
              },
              { key: "action", label: "处理", children: actionName(values?.action) },
            ]}
          />
          <Segmented
            size="small"
            value={range}
            onChange={value => setRange(String(value))}
            options={replayRanges.map(item => ({ value: item.value, label: item.label }))}
          />
          <Space size={6} wrap>
            <Tag>样本 {samples.length}</Tag>
            <Tag>命中 {confirmed.length}</Tag>
            <Tag color={confirmed.some(item => item.first !== rule?.id) ? "orange" : undefined}>
              生效 {confirmed.filter(item => item.first === rule?.id).length}
            </Tag>
            {matches.length > confirmed.length && (
              <Tag>无法验证 {matches.length - confirmed.length}</Tag>
            )}
          </Space>
          {byPlugin.length > 0 && (
            <Space size={4} wrap>
              <span className="muted">生效集中在</span>
              {byPlugin.map(([plugin, count]) => (
                <Tag key={plugin}>
                  {plugin} × {count}
                </Tag>
              ))}
            </Space>
          )}
          {truncated && <Tag color="orange">范围内事件很多，只回放了最近 2000 条</Tag>}
          {sampleError && <Tag color="orange">样本读取失败</Tag>}
          {confirmed.some(item => item.first !== rule?.id) && (
            <Alert type="warning" showIcon title="部分样本先命中其他规则" />
          )}
        </div>
        <Collapse
          ghost
          items={[
            {
              key: "advanced",
              label: "高级",
              children: (
                <>
                  <Form.Item
                    label="规则标识"
                    name="id"
                    rules={[
                      { required: true, whitespace: true, message: "填写规则标识" },
                      { max: 100, message: "最多 100 个字符" },
                      { pattern: /^[^\0\r\n]+$/, message: "不能包含换行或空字符" },
                    ]}
                  >
                    <Input aria-label="规则标识" maxLength={100} />
                  </Form.Item>
                  <pre className="json-code">{JSON.stringify(rule, null, 2)}</pre>
                </>
              ),
            },
          ]}
        />
      </Form>
    </Drawer>
  )
}
