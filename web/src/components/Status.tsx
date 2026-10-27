import { Button, Space, Tag } from "antd"
import { useConsole } from "../state"
import { FieldHelp } from "./FieldHelp"

/** 显示配置应用状态。 */
export function ConfigurationState() {
  const {
    dirty,
    pendingRestart,
    saving,
    connected,
    configurationLoaded,
    configurationError,
    apply,
    save,
  } = useConsole()
  const confirmed = connected && configurationLoaded && !configurationError
  const status = apply?.status ?? (pendingRestart ? "pending-restart" : "applied")
  return (
    <Space size={6} className="configuration-state" aria-live="polite">
      {!connected && <Tag color="error">连接未确认</Tag>}
      {connected && !configurationLoaded && <Tag>配置未读取</Tag>}
      {connected && configurationError && <Tag color="error">配置异常</Tag>}
      {saving && <Tag color="processing">保存中</Tag>}
      {!saving && dirty && <Tag color="gold">未保存</Tag>}
      {confirmed && !saving && status === "applying" && <Tag color="processing">应用中</Tag>}
      {confirmed && !saving && status === "pending-restart" && <Tag color="orange">需重启</Tag>}
      {confirmed && !saving && status === "failed" && (
        <Space size={0}>
          <Tag color="error">失败</Tag>
          {apply?.error && <FieldHelp label="应用失败" help={{ description: apply.error }} />}
          <Button type="text" size="small" disabled={dirty} onClick={() => void save()}>
            重试
          </Button>
        </Space>
      )}
      {confirmed && !dirty && !saving && status === "applied" && <Tag>已保存</Tag>}
    </Space>
  )
}
