import { useEffect, useState } from "react"
import { Alert, App, Button, Drawer, Empty, Select, Space, Spin, Tag } from "antd"
import { api } from "../api"
import { useConsole } from "../state"
import { goTo } from "../navigation"
import type { AuditEntry, PluginDiagnosis as Diagnosis, TaskCase } from "../types"
import { CaseBatch } from "./CaseBatch"
import { EventDetails } from "./EventDetails"
import { RecoveryGuide } from "./RecoveryGuide"
import { UndoOperation } from "./Status"

/** 只展示可核对的拦截与宿主故障证据，不从日志猜测插件根因。 */
export function PluginDiagnosis({
  open,
  plugin,
  onClose,
}: {
  open: boolean
  plugin?: string
  onClose: () => void
}) {
  const ctx = useConsole()
  const { message } = App.useApp()
  const [selected, setSelected] = useState<string>()
  const [data, setData] = useState<Diagnosis>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [version, setVersion] = useState(0)
  const [batch, setBatch] = useState<TaskCase[]>([])
  const [event, setEvent] = useState<AuditEntry | null>(null)
  const [recovery, setRecovery] = useState(false)
  useEffect(() => {
    if (open) setSelected(plugin)
  }, [open, plugin])
  useEffect(() => {
    if (!open || !selected) {
      setData(undefined)
      setLoading(false)
      setError("")
      return
    }
    let live = true
    setLoading(true)
    setError("")
    void api<Diagnosis>(`/api/plugins/diagnose?plugin=${encodeURIComponent(selected)}`)
      .then(result => {
        if (live) setData(result)
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
  }, [open, selected, version, ctx.settingsRevision, ctx.apply?.status])
  function action(finding: Diagnosis["findings"][number]) {
    if (finding.action === "review-cases")
      setBatch(
        (data?.cases ?? []).filter(item => !finding.caseIds || finding.caseIds.includes(item.id)),
      )
    else if (finding.action === "retry-apply") void ctx.save()
    else if (finding.action === "inspect-startup") setRecovery(true)
    else if (finding.action === "restart-host") {
      onClose()
      goTo("runtime")
    } else if (finding.action === "wait")
      void ctx.reload(true).catch(error => message.error(error.message))
    else {
      onClose()
      goTo("logs")
    }
  }
  const labels = {
    "review-cases": "处理拦截",
    "retry-apply": "重试应用",
    "inspect-startup": "检查启动",
    "restart-host": "查看配置",
    wait: "刷新状态",
    "view-logs": "查看日志",
  }
  return (
    <>
      <Drawer
        title="插件没反应"
        open={open}
        onClose={onClose}
        size={720}
        styles={{ wrapper: { width: "min(720px, 100vw)" } }}
      >
        <div className="page-stack">
          <Select
            aria-label="排查插件"
            placeholder="选择插件"
            showSearch
            optionFilterProp="label"
            value={selected}
            onChange={setSelected}
            options={ctx.plugins.map(item => ({ value: item.id, label: item.id }))}
          />
          {loading ? (
            <Spin />
          ) : error ? (
            <Alert type="error" title={error} />
          ) : data ? (
            data.findings.map((finding, index) => (
              <section key={`${finding.kind}-${index}`} className="diagnosis-item">
                <div className="history-item-heading">
                  <strong>{finding.title}</strong>
                  <Tag>{finding.scope === "global" ? "全局状态" : "插件记录"}</Tag>
                </div>
                <p>{finding.detail}</p>
                <Space wrap>
                  <Button
                    disabled={
                      ctx.saving ||
                      !ctx.connected ||
                      (finding.action === "retry-apply" && ctx.dirty)
                    }
                    onClick={() => action(finding)}
                  >
                    {labels[finding.action]}
                  </Button>
                  {finding.kind === "configuration" && <UndoOperation />}
                  {(finding.evidence ?? []).slice(0, 2).map(item => (
                    <Button size="small" key={item.id} onClick={() => setEvent(item)}>
                      查看记录
                    </Button>
                  ))}
                </Space>
              </section>
            ))
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择插件后检查" />
          )}
          {data && !data.coverage.complete && <span className="muted">仅依据当前可读记录</span>}
          {selected && <Button onClick={() => setVersion(value => value + 1)}>重新检查</Button>}
        </div>
      </Drawer>
      <CaseBatch
        open={Boolean(batch.length)}
        cases={batch}
        revision={data?.revision}
        onClose={() => setBatch([])}
        onDone={() => {
          setVersion(value => value + 1)
          void ctx.reload(true).catch(() => {})
        }}
      />
      <EventDetails entry={event} onClose={() => setEvent(null)} />
      <RecoveryGuide open={recovery} onClose={() => setRecovery(false)} />
    </>
  )
}
