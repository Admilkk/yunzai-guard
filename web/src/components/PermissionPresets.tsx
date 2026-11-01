import { Dropdown, Button, Tooltip } from "antd"
import { useConsole } from "../state"
import { applyPermissionPreset, permissionPresets } from "../lib/quick-actions"

/** 单插件与批量列表共用的快捷权限套餐。 */
export function PermissionPresets({ ids }: { ids: string[] }) {
  const ctx = useConsole()
  const disabled = !ids.length || ctx.saving || !ctx.connected
  return (
    <Tooltip title={ctx.dirty ? "加入现有草稿" : undefined}>
      <Dropdown
        trigger={["click"]}
        disabled={disabled}
        menu={{
          items: permissionPresets.map(preset => ({
            key: preset.id,
            label: preset.label,
            onClick: () => {
              void ctx.quickChange(
                preset.label,
                `插件（${ids.length}）：${ids.join("、")}\n${preset.description}${preset.id === "inherit" ? "" : "新规则优先匹配。"}`,
                document => {
                  if (ids.some(id => !ctx.plugins.some(plugin => plugin.id === id)))
                    throw new Error("插件列表已变更，请刷新")
                  applyPermissionPreset(document, ids, preset.id)
                },
              )
            },
          })),
        }}
      >
        <Button disabled={disabled}>快捷权限套餐{ctx.dirty ? "（暂存）" : ""}</Button>
      </Dropdown>
    </Tooltip>
  )
}
