import { Alert, Button, Space, Tag, Tooltip } from "antd"
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
      {confirmed && !saving && status === "pending-restart" && <Tag color="orange">需重启宿主</Tag>}
      {confirmed && !saving && status === "failed" && (
        <Space size={0}>
          <Tag color="error">失败</Tag>
          {apply?.error && <FieldHelp label="应用失败" help={{ description: apply.error }} />}
          <Button type="text" size="small" disabled={dirty} onClick={() => void save()}>
            重试
          </Button>
        </Space>
      )}
      {confirmed && !dirty && !saving && status === "applied" && (
        <Tag>{apply ? "已生效" : "已保存"}</Tag>
      )}
    </Space>
  )
}

/** 跨页面保留应用结果与单次撤销入口，不把落盘成功当成运行成功。 */
export function ConfigurationFeedback() {
  const ctx = useConsole()
  if (!ctx.connected || !ctx.configurationLoaded || ctx.configurationError) return null
  const status = ctx.apply?.status
  if (
    !ctx.lastOperation &&
    status !== "failed" &&
    status !== "pending-restart" &&
    status !== "applying"
  )
    return null
  const title =
    status === "failed"
      ? "已保存，应用失败"
      : status === "applying"
        ? "正在应用"
        : status === "pending-restart"
          ? "已保存，待宿主重启"
          : ctx.apply
            ? "已生效"
            : "已保存，生效未确认"
  const description =
    status === "failed"
      ? ctx.apply?.error
      : status === "applying"
        ? ctx.apply?.reloadFields.length
          ? "重启业务中，机器人暂时断开"
          : undefined
        : status === "pending-restart"
          ? `${ctx.apply?.restartFields.join("、")}：通过进程管理器重启宿主，重启业务无效。`
          : ctx.lastOperation
            ? ctx.lastOperation.revision === ctx.settingsRevision
              ? ctx.lastOperation.title
              : "配置已有后续修改，请从历史备份恢复"
            : undefined
  return (
    <Alert
      className={`configuration-feedback${status === "applied" ? " is-settled" : ""}`}
      showIcon
      type={
        status === "failed"
          ? "error"
          : status === "pending-restart"
            ? "warning"
            : status === "applying" || !ctx.apply
              ? "info"
              : "success"
      }
      title={title}
      description={description}
      action={
        <Space wrap>
          {status === "failed" && (
            <Button size="small" disabled={ctx.dirty || ctx.saving} onClick={() => void ctx.save()}>
              重试应用
            </Button>
          )}
          <UndoOperation />
        </Space>
      }
    />
  )
}

/** 在结果提示和抽屉内提供一致的撤销入口。 */
export function UndoOperation() {
  const ctx = useConsole()
  if (!ctx.lastOperation) return null
  return (
    <Tooltip
      title={!ctx.canUndo ? "有草稿、后续修改或连接异常，请查看操作记录" : "撤销最近一次修改"}
    >
      <Button size="small" disabled={!ctx.canUndo} onClick={() => void ctx.undoLast()}>
        撤销本次修改
      </Button>
    </Tooltip>
  )
}
