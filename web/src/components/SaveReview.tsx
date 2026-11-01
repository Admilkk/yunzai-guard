import { Alert, Collapse } from "antd"
import { formatChange } from "../lib/diff"
import type { ConfigChange } from "../lib/diff"
import type { SettingsPlan } from "../types"

/** 保存前说明具体影响；生效计划由服务端使用实际配置计算。 */
export function SaveReview({
  summary,
  plan,
  changes,
  expanded = false,
}: {
  summary: string
  plan: SettingsPlan
  changes: ConfigChange[]
  expanded?: boolean
}) {
  return (
    <div className="quick-review">
      <p>{summary}</p>
      {plan.reloadFields.length > 0 && (
        <Alert type="warning" showIcon title="保存后重启业务，机器人将短暂断开" />
      )}
      {plan.restartFields.length > 0 && (
        <Alert
          type="warning"
          showIcon
          title="需重启 Guard 宿主"
          description={`${plan.restartFields.join("、")}：通过进程管理器重启宿主，重启业务无效。`}
        />
      )}
      {!plan.reloadFields.length && !plan.restartFields.length && <p className="muted">无需重启</p>}
      <Collapse
        size="small"
        defaultActiveKey={expanded ? ["changes"] : []}
        items={[
          {
            key: "changes",
            label: changes.length ? `${changes.length} 项更改` : "仅原文或注释更改",
            children: (
              <ul className="quick-change-list">
                {changes.map(item => (
                  <li key={item.path}>
                    <code>{item.path}</code>
                    <div>
                      {formatChange(item.before)} → {formatChange(item.after)}
                    </div>
                  </li>
                ))}
              </ul>
            ),
          },
        ]}
      />
    </div>
  )
}
