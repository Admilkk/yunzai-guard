import { useEffect, useState } from "react"
import { Alert, App, Button, Checkbox, Empty, Space, Spin, Tag, Tooltip } from "antd"
import { ReloadOutlined } from "@ant-design/icons"
import { PanelCard } from "../components"
import { useConsole } from "../state"
import { goTo } from "../navigation"
import { api } from "../api"
import { acknowledgeCases } from "../lib/case-actions"
import { operationName } from "../lib/labels"
import { siteShortcutTarget } from "../lib/quick-actions"
import { sampleDecision } from "../lib/rules"
import { RecoveryGuide } from "./RecoveryGuide"
import { CaseBatch } from "./CaseBatch"
import { EventActions } from "./EventActions"
import { OperationHistory } from "./OperationHistory"
import { PluginDiagnosis } from "./PluginDiagnosis"
import type { AuditEntry, TaskCase, TaskCases } from "../types"

/** 同范围记录合并成处理卡，标记保持现状后只隐藏该上下文的待办。 */
export function TasksCard({ onEvent }: { onEvent: (entry: AuditEntry) => void }) {
  const ctx = useConsole()
  const { message } = App.useApp()
  const [data, setData] = useState<TaskCases>()
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [version, setVersion] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [expanded, setExpanded] = useState(false)
  const [working, setWorking] = useState(false)
  const [batch, setBatch] = useState(false)
  const [recovery, setRecovery] = useState(false)
  const [history, setHistory] = useState(false)
  const [diagnosis, setDiagnosis] = useState(false)
  const status = ctx.overview?.status ?? {}
  useEffect(() => {
    let live = true
    setLoading(true)
    void api<TaskCases>("/api/tasks")
      .then(result => {
        if (live) {
          setData(result)
          setError("")
          setSelected(ids => ids.filter(id => result.cases.some(item => item.id === id)))
        }
      })
      .catch(error => {
        if (live) setError(error.message)
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [
    version,
    ctx.settingsRevision,
    ctx.apply?.status,
    ctx.overview?.audit?.summary?.total,
    ctx.overview?.audit?.coverage?.windowEnd,
  ])
  const cases = data?.cases ?? []
  const selectedCases = cases.filter(item => selected.includes(item.id))
  const visible = expanded ? cases : cases.slice(0, 8)
  const done = () => {
    setVersion(value => value + 1)
    setSelected([])
  }
  async function keep(items: TaskCase[]) {
    setWorking(true)
    try {
      if (!data) return
      await acknowledgeCases(items, data.revision)
      message.success("已核对")
      done()
    } catch (error) {
      message.error((error as Error).message)
    } finally {
      setWorking(false)
    }
  }
  return (
    <>
      <PanelCard
        className="tasks-card"
        title={
          <Space>
            <span>需要处理</span>
            <Tag>{cases.length} 组</Tag>
          </Space>
        }
        extra={
          <Space wrap>
            <Button onClick={() => setDiagnosis(true)}>插件没反应</Button>
            <Button onClick={() => setHistory(true)}>操作记录</Button>
            <Button
              icon={<ReloadOutlined />}
              aria-label="刷新待办"
              loading={loading}
              onClick={() => setVersion(value => value + 1)}
            />
          </Space>
        }
      >
        <div className="page-stack">
          {ctx.configurationError && (
            <Alert
              type="error"
              title="配置读取异常"
              description={ctx.configurationError}
              action={<Button onClick={() => goTo("advanced")}>修正配置</Button>}
            />
          )}
          {(status.trippedReason ||
            (!status.workerPid &&
              ctx.apply?.status !== "applying" &&
              !["starting", "restarting", "handoff", "stopping", "stopped"].includes(
                status.phase,
              ))) && (
            <Alert
              type="error"
              title={status.trippedReason ? "业务已熔断" : "业务未运行"}
              description={status.trippedReason}
              action={<Button onClick={() => setRecovery(true)}>检查原因</Button>}
            />
          )}
          {ctx.apply?.status === "failed" && (
            <Alert
              type="error"
              title="配置应用失败"
              description={ctx.apply.error}
              action={<Button onClick={() => setRecovery(true)}>查看原因</Button>}
            />
          )}
          {ctx.apply?.status === "pending-restart" && (
            <Alert
              type="warning"
              title="配置待宿主重启"
              description="通过进程管理器重启宿主，重启业务无效"
            />
          )}
          {ctx.apply?.status === "applying" && (
            <Alert
              type="info"
              title="配置应用中"
              description={ctx.apply.reloadFields.length ? "重启业务中" : "等待宿主确认"}
            />
          )}
          {error && <Alert type="error" title={error} />}
          {cases.length > 0 && (
            <div className="case-selection">
              <Space wrap>
                <Checkbox
                  checked={selected.length === cases.length}
                  indeterminate={selected.length > 0 && selected.length < cases.length}
                  onChange={event =>
                    setSelected(event.target.checked ? cases.map(item => item.id) : [])
                  }
                >
                  全选
                </Checkbox>
                <Button
                  type="primary"
                  disabled={!selectedCases.length || ctx.saving || working}
                  onClick={() => setBatch(true)}
                >
                  批量处理{selectedCases.length ? `（${selectedCases.length}）` : ""}
                </Button>
                <Button
                  disabled={!selectedCases.length || working || ctx.saving}
                  onClick={() => void keep(selectedCases)}
                >
                  保持现状
                </Button>
              </Space>
              <span className="muted">
                已读样本{data?.coverage.truncated ? " · 范围不完整" : ""}
              </span>
            </div>
          )}
          <div className="task-case-grid">
            {visible.map(item => {
              const draftDecision = sampleDecision(item.entry, ctx.draft.rules ?? [])
              const staged =
                ctx.dirty &&
                !draftDecision.uncertain &&
                draftDecision.action !== (item.currentAction ?? item.action)
              return (
                <section className="task-case" key={item.id} data-case-id={item.id}>
                  <div className="task-case-heading">
                    <Checkbox
                      checked={selected.includes(item.id)}
                      onChange={event =>
                        setSelected(ids =>
                          event.target.checked
                            ? [...ids, item.id]
                            : ids.filter(id => id !== item.id),
                        )
                      }
                      aria-label={`选择 ${item.plugin} ${item.target}`}
                    />
                    <strong>{item.plugin}</strong>
                    <Tag>{item.count} 条</Tag>
                    {staged && <Tag color="blue">待应用</Tag>}
                  </div>
                  <span className="task-case-operation">{operationName(item.operation)}</span>
                  <code className="task-case-target">
                    {siteShortcutTarget(item.entry) ?? item.target}
                  </code>
                  <span
                    className="task-case-rule muted"
                    title={item.currentRuleId ?? item.ruleId ?? "默认处置"}
                  >
                    规则：{item.currentRuleId ?? item.ruleId ?? "默认处置"}
                    {item.uncertain ? " · 匹配未确认" : ""}
                  </span>
                  <div className="task-case-actions">
                    <Tooltip title="标记已核对，保留现有规则">
                      <Button
                        size="small"
                        disabled={working || ctx.saving}
                        onClick={() => void keep([item])}
                      >
                        {item.currentAction === "restart" || item.action === "restart"
                          ? "保持现状"
                          : "保持拦截"}
                      </Button>
                    </Tooltip>
                    <EventActions
                      entry={item.entry}
                      compact
                      card
                      onDetails={() => onEvent(item.entry)}
                    />
                  </div>
                </section>
              )
            })}
          </div>
          {loading && !data && <Spin />}
          {!loading && !cases.length && !error && (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待办" />
          )}
          {cases.length > 8 && (
            <Button onClick={() => setExpanded(value => !value)}>
              {expanded ? "收起" : `展开其余 ${cases.length - 8} 组`}
            </Button>
          )}
        </div>
      </PanelCard>
      <CaseBatch
        open={batch}
        cases={selectedCases}
        revision={data?.revision}
        onClose={() => setBatch(false)}
        onDone={done}
      />
      <OperationHistory open={history} onClose={() => setHistory(false)} />
      <PluginDiagnosis open={diagnosis} onClose={() => setDiagnosis(false)} />
      <RecoveryGuide open={recovery} onClose={() => setRecovery(false)} />
    </>
  )
}
