import { useEffect } from "react"
import { Alert, Button, Drawer, Empty, Space, Tag, Tooltip } from "antd"
import { useConsole } from "../state"
import { formatTime } from "../components"

const statusLabels = {
  applied: "已生效",
  applying: "应用中",
  "pending-restart": "待宿主重启",
  failed: "应用失败",
  unknown: "未确认",
}

/** 操作记录保存在宿主，刷新或换设备后仍可核对差异并恢复。 */
export function OperationHistory({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ctx = useConsole()
  useEffect(() => {
    if (open) void ctx.reload(true).catch(() => {})
  }, [open, ctx.reload])
  const previous = ctx.operations.find(
    item => item.status === "applied" && item.canRestore && item.revision !== ctx.settingsRevision,
  )
  return (
    <Drawer
      title="操作记录"
      open={open}
      onClose={onClose}
      size={760}
      styles={{ wrapper: { width: "min(760px, 100vw)" } }}
    >
      <div className="page-stack">
        <Space wrap>
          <Button
            type="primary"
            disabled={!previous || ctx.dirty || ctx.saving || !ctx.connected}
            onClick={() => previous && void ctx.restoreOperation(previous.id, "after")}
          >
            恢复上次生效配置
          </Button>
          <span className="muted">恢复前会显示差异</span>
        </Space>
        {ctx.dirty && <Alert type="info" title="先保存或放弃草稿" />}
        {ctx.historyError && <Alert type="error" title={ctx.historyError} />}
        {!ctx.operations.length && !ctx.historyError && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无操作记录" />
        )}
        {ctx.operations.map(item => (
          <section className="history-item" key={item.id} data-operation-id={item.id}>
            <div className="history-item-heading">
              <strong>{item.title}</strong>
              <Tag
                color={
                  item.status === "failed" ? "red" : item.status === "applied" ? "green" : undefined
                }
              >
                {statusLabels[item.status]}
              </Tag>
            </div>
            <span className="muted">
              {formatTime(item.time, true)} · {item.changes.length} 项更改
              {item.revision === ctx.settingsRevision ? " · 当前版本" : ""}
            </span>
            <Space wrap>
              <Tooltip title={item.canUndo ? "恢复修改前的配置" : "包含后续修改，恢复前需核对差异"}>
                <Button
                  size="small"
                  disabled={!item.canRestoreBefore || ctx.dirty || ctx.saving || !ctx.connected}
                  onClick={() => void ctx.restoreOperation(item.id, "before")}
                >
                  {item.canUndo ? "撤销" : "恢复修改前"}
                </Button>
              </Tooltip>
              {item.canRestore && (
                <Button
                  size="small"
                  disabled={
                    item.revision === ctx.settingsRevision ||
                    ctx.dirty ||
                    ctx.saving ||
                    !ctx.connected
                  }
                  onClick={() => void ctx.restoreOperation(item.id, "after")}
                >
                  恢复此版本
                </Button>
              )}
            </Space>
          </section>
        ))}
      </div>
    </Drawer>
  )
}
