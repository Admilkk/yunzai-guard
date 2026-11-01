import { Button, Dropdown, Space, Tooltip } from "antd"
import { useConsole } from "../state"
import { addEventShortcut, eventShortcutProblem, siteShortcutTarget } from "../lib/quick-actions"
import { sampleDecision } from "../lib/rules"
import { actionName, operationName } from "../lib/labels"
import type { AuditEntry, RuleAction } from "../types"
import { MoreOutlined } from "@ant-design/icons"

/** 在事件旁提供精确放行与拦截，确认前展示现有规则与实际作用范围。 */
export function EventActions({
  entry,
  compact = false,
  card = false,
  onDetails,
}: {
  entry: AuditEntry
  compact?: boolean
  card?: boolean
  onDetails?: () => void
}) {
  const ctx = useConsole()
  const site = siteShortcutTarget(entry)
  const scope = site ? "site" : "exact"
  const problem = eventShortcutProblem(entry, scope)
  const blocked = problem
  const current = sampleDecision(entry, ctx.draft.rules ?? [])
  const label = (action: RuleAction) =>
    site
      ? action === "audit"
        ? "放行此站点并记录"
        : "拦截此站点访问"
      : action === "audit"
        ? compact
          ? "放行并记录"
          : "放行此行为并保留记录"
        : "拦截此行为"
  const run = (action: RuleAction, mode: "apply" | "draft" = "apply") => {
    const title = label(action)
    void ctx.quickChange(
      title,
      `${entry.plugin} · ${operationName(entry.operation)}\n目标：${site ?? entry.target}${site ? "（全部路径）" : ""}\n${current.uncertain ? "路径已脱敏，当前匹配结果不确定" : `当前：${actionName(current.action)}`} → ${actionName(action)}\n新规则优先匹配。`,
      document =>
        // 规则编号不是凭据；不依赖仅在 HTTPS 可用的 randomUUID，兼容局域网 HTTP 面板。
        addEventShortcut(
          document,
          entry,
          action,
          `panel.event.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`,
          scope,
        ),
      mode,
    )
  }
  if (card)
    return (
      <Space size={6} wrap className="case-event-actions">
        {!problem && (
          <Tooltip title={site ? "该插件 · 此操作 · 站点全部路径" : undefined}>
            <Button
              className="case-allow"
              size="small"
              disabled={ctx.saving || !ctx.connected || (!site && current.action === "audit")}
              onClick={() => run("audit")}
            >
              {label("audit")}
              {ctx.dirty ? "（暂存）" : ""}
            </Button>
          </Tooltip>
        )}
        <Dropdown
          trigger={["click"]}
          menu={{
            items: [
              ...(!problem
                ? [
                    {
                      key: "deny",
                      label: label("deny"),
                      danger: true,
                      disabled:
                        ctx.saving || !ctx.connected || (!site && current.action === "deny"),
                      onClick: () => run("deny"),
                    },
                    ...(!ctx.dirty
                      ? [
                          {
                            key: "stage",
                            label: "加入草稿",
                            children: (["audit", "deny"] as const).map(action => ({
                              key: `stage-${action}`,
                              label: label(action),
                              disabled: ctx.saving || !ctx.connected,
                              onClick: () => run(action, "draft"),
                            })),
                          },
                        ]
                      : []),
                    { type: "divider" as const },
                  ]
                : []),
              { key: "details", label: "查看详情", onClick: onDetails },
            ],
          }}
        >
          <Button
            type="text"
            size="small"
            icon={<MoreOutlined />}
            aria-label={`${entry.plugin} 更多处理`}
          />
        </Dropdown>
      </Space>
    )
  if (problem && compact) return null
  return (
    <div
      className="event-actions"
      onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation()
      }}
    >
      <Space size={4} wrap>
        {(["audit", "deny"] as const).map(action => (
          <Tooltip
            key={action}
            title={
              blocked ??
              (!site && current.action === action
                ? "当前已采用此处理方式"
                : site
                  ? "该插件 · 此操作 · 站点全部路径"
                  : undefined)
            }
          >
            <Button
              size={compact ? "small" : "middle"}
              type={compact ? "link" : "default"}
              danger={action === "deny"}
              disabled={
                Boolean(blocked) ||
                ctx.saving ||
                !ctx.connected ||
                (!site && current.action === action)
              }
              onClick={() => run(action)}
            >
              {label(action)}
              {ctx.dirty ? "（暂存）" : ""}
            </Button>
          </Tooltip>
        ))}
        {!ctx.dirty && !problem && (
          <Dropdown
            trigger={["click"]}
            disabled={ctx.saving || !ctx.connected}
            menu={{
              items: (["audit", "deny"] as const).map(action => ({
                key: action,
                label: label(action),
                onClick: () => run(action, "draft"),
              })),
            }}
          >
            <Button size={compact ? "small" : "middle"} type="text">
              加入草稿
            </Button>
          </Dropdown>
        )}
      </Space>
      {problem && !compact && <p className="muted">{problem}，请手动创建规则。</p>}
      {site && !problem && !compact && (
        <p className="muted">路径已脱敏，快捷操作覆盖整个站点。精确路径需手动创建规则。</p>
      )}
    </div>
  )
}
