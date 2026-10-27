import { Tabs } from "antd"
import Advanced from "./Advanced"
import Runtime from "./Runtime"
import Security from "./Security"

export type SettingsSection = "runtime" | "security" | "advanced"

/** 面板设置页面。 */
export default function Settings({
  section,
  onChange,
}: {
  section: SettingsSection
  onChange: (section: SettingsSection) => void
}) {
  return (
    <Tabs
      className="settings-page-tabs"
      activeKey={section}
      onChange={key => onChange(key as SettingsSection)}
      items={[
        { key: "runtime", label: "运行与监控", children: <Runtime /> },
        { key: "advanced", label: "沙箱与高级配置", children: <Advanced /> },
        { key: "security", label: "会话与面板", children: <Security /> },
      ]}
    />
  )
}
