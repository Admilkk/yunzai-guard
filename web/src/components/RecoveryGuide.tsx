import { useEffect, useState } from "react"
import { Alert, App, Button, Descriptions, Drawer, Space } from "antd"
import { api } from "../api"
import { useConsole } from "../state"
import { goTo } from "../navigation"
import { phaseName } from "../components"
import { UndoOperation } from "./Status"

/** 将故障依据、日志和恢复操作放在同一处，恢复不改变故障相关权限。 */
export function RecoveryGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ctx = useConsole()
  const { message, modal } = App.useApp()
  const [logs, setLogs] = useState("")
  const [pending, setPending] = useState(false)
  const [logError, setLogError] = useState("")
  const status = ctx.overview?.status ?? {}
  useEffect(() => {
    if (!open) return
    let live = true
    setLogs("")
    setLogError("")
    void api("/api/logs")
      .then(result => {
        if (live)
          setLogs(
            String(result.text ?? "")
              .split(/\r?\n/)
              .slice(-80)
              .join("\n") || "暂无日志",
          )
      })
      .catch(error => {
        if (live) setLogError(error.message)
      })
    return () => {
      live = false
    }
  }, [open, ctx.overview])

  function recover() {
    modal.confirm({
      title: status.trippedReason ? "解除熔断并启动？" : "重试启动业务？",
      content: "修复故障后再重试。",
      okText: "重试启动",
      cancelText: "继续排查",
      onOk: async () => {
        setPending(true)
        try {
          await api(`/api/actions/${status.trippedReason ? "resume" : "restart"}`, {
            method: "POST",
            body: "{}",
          })
          message.info("已请求启动")
          await ctx.reload(true)
        } catch (error) {
          message.error((error as Error).message)
        } finally {
          setPending(false)
        }
      },
    })
  }
  return (
    <Drawer
      title="运行诊断"
      open={open}
      onClose={onClose}
      size={680}
      styles={{ wrapper: { width: "min(680px, 100vw)" } }}
    >
      <div className="page-stack">
        <Alert
          showIcon
          type={status.trippedReason ? "error" : "info"}
          title={status.trippedReason ?? "故障排查"}
          description="检查日志，修复后重试。"
        />
        <Descriptions
          column={1}
          items={[
            { key: "phase", label: "业务状态", children: phaseName(status.phase) },
            {
              key: "failures",
              label: "恢复窗口内故障",
              children: `${status.recoveryCount ?? 0} 次`,
            },
            {
              key: "config",
              label: "配置检查",
              children:
                ctx.configurationError ??
                (ctx.apply?.status === "failed" ? ctx.apply.error : "未报告配置错误"),
            },
          ]}
        />
        {logError ? (
          <Alert type="warning" title={`日志读取失败：${logError}`} />
        ) : (
          <pre className="recovery-log">{logs || "读取中…"}</pre>
        )}
        <Space wrap>
          {ctx.apply?.status === "failed" && (
            <Button disabled={ctx.dirty || ctx.saving} onClick={() => void ctx.save()}>
              重试应用配置
            </Button>
          )}
          <UndoOperation />
          <Button
            onClick={() => {
              onClose()
              goTo("logs")
            }}
          >
            查看完整日志
          </Button>
          <Button
            onClick={() => {
              onClose()
              goTo("advanced")
            }}
          >
            配置与备份
          </Button>
          <Button
            type="primary"
            loading={pending}
            disabled={
              !ctx.connected ||
              ctx.saving ||
              ctx.dirty ||
              Boolean(ctx.configurationError) ||
              ctx.apply?.status === "applying"
            }
            onClick={recover}
          >
            重试启动
          </Button>
        </Space>
      </div>
    </Drawer>
  )
}
