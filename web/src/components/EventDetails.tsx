import { useEffect, useMemo, useState } from "react"
import { Button, Collapse, Descriptions, Drawer, Tag, Tooltip } from "antd"
import { ActionTag, formatTime } from "../components"
import type { AuditEntry } from "../types"
import { functionName, kindName, operationName } from "../lib/labels"
import { canCreateRule, eventRule } from "../lib/rules"
import { RuleEditor } from "./RuleEditor"

/** 返回事件来源（插件或运行时）的显示名称。 */
export function eventSource(entry: AuditEntry): string {
  if (entry.plugin === "unknown")
    return ["system", "coverage"].includes(entry.kind) ? "系统记录" : "未知来源"
  return entry.plugin
}

/** 事件详情面板，可从事件创建规则。 */
export function EventDetails({
  entry,
  onClose,
}: {
  entry: AuditEntry | null
  onClose: () => void
}) {
  const [composing, setComposing] = useState(false)
  useEffect(() => setComposing(false), [entry?.id])
  const seed = useMemo(() => (entry ? eventRule(entry) : undefined), [entry])
  const rule =
    entry?.ruleId ??
    (entry?.kind === "self-protection"
      ? "固定自保护"
      : entry?.action === "info"
        ? "—"
        : "未记录规则来源")
  return (
    <>
      <Drawer
        title={entry ? operationName(entry.operation) : "事件详情"}
        open={Boolean(entry)}
        onClose={onClose}
        size={620}
        styles={{ wrapper: { width: "min(620px, 100vw)", maxWidth: "100vw" } }}
        className="details-drawer"
        extra={
          entry && canCreateRule(entry) ? (
            <Button onClick={() => setComposing(true)}>创建规则</Button>
          ) : undefined
        }
      >
        {entry && (
          <>
            <Descriptions
              column={1}
              size="small"
              items={[
                { key: "time", label: "时间", children: formatTime(entry.time, true) },
                { key: "plugin", label: "来源", children: eventSource(entry) },
                {
                  key: "kind",
                  label: "类型",
                  children: <Tooltip title={entry.kind}>{kindName(entry.kind)}</Tooltip>,
                },
                {
                  key: "operation",
                  label: "操作",
                  children: (
                    <Tooltip title={entry.operation}>{operationName(entry.operation)}</Tooltip>
                  ),
                },
                {
                  key: "target",
                  label: "目标",
                  children: (
                    <Tooltip title={entry.target}>{functionName(entry.target) || "—"}</Tooltip>
                  ),
                },
                { key: "action", label: "处理", children: <ActionTag action={entry.action} /> },
                { key: "rule", label: "规则来源", children: rule },
                {
                  key: "blocked",
                  label: "阻断状态",
                  children:
                    entry.blocked === true ? (
                      <Tag color="red">已报告阻断</Tag>
                    ) : entry.blocked === false ? (
                      <Tag>未阻断</Tag>
                    ) : (
                      <Tag>未确认</Tag>
                    ),
                },
              ]}
            />
            <Collapse
              ghost
              items={[
                {
                  key: "raw",
                  label: "原始记录",
                  children: (
                    <pre className="json-code">{JSON.stringify(entry.details ?? {}, null, 2)}</pre>
                  ),
                },
              ]}
            />
          </>
        )}
      </Drawer>
      <RuleEditor
        open={composing && Boolean(entry)}
        seed={seed}
        sample={entry ?? undefined}
        onClose={() => setComposing(false)}
      />
    </>
  )
}
