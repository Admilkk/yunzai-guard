import { useEffect, useState } from "react"
import { Alert, App, Button, Drawer, Select, Space, Tag } from "antd"
import { useConsole } from "../state"
import { operationName } from "../lib/labels"
import {
  acknowledgeCases,
  acknowledgeCasesAfterApply,
  applyCaseChoices,
  caseProblem,
  type CaseChoice,
} from "../lib/case-actions"
import { siteShortcutTarget } from "../lib/quick-actions"
import type { TaskCase } from "../types"

export function CaseBatch({
  open,
  cases,
  revision,
  onClose,
  onDone,
}: {
  open: boolean
  cases: TaskCase[]
  revision?: string
  onClose: () => void
  onDone: () => void
}) {
  const ctx = useConsole()
  const { message } = App.useApp()
  const [actions, setActions] = useState<Record<string, "skip" | "keep" | "audit" | "deny">>({})
  const [working, setWorking] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const busy = working || ctx.saving
  const hasActions = Object.values(actions).some(action => action !== "skip")
  const [snapshot, setSnapshot] = useState<{ cases: TaskCase[]; revision?: string }>({ cases: [] })
  useEffect(() => {
    if (open) {
      setActions({})
      setSnapshot({ cases: structuredClone(cases), revision })
    }
  }, [open])
  async function apply(mode: "apply" | "draft") {
    setWorking(true)
    try {
      if (!snapshot.revision) throw new Error("待办版本未读取，请重试")
      if (snapshot.revision !== ctx.settingsRevision) throw new Error("配置已变更，请重新选择待办")
      const choices = snapshot.cases
        .map(item => {
          const selected = actions[item.id] ?? ("skip" as const)
          return {
            item,
            action:
              !item.uncertain && selected === item.currentAction ? ("keep" as const) : selected,
          }
        })
        .filter((choice): choice is CaseChoice => choice.action !== "skip")
      if (!choices.length) return
      const changes = choices.filter(choice => choice.action !== "keep")
      let outcome: false | { staged: boolean; revision?: string } = false
      if (changes.length) {
        const summary = choices
          .map(
            ({ item, action }) =>
              `${item.plugin} · ${operationName(item.operation)} · ${siteShortcutTarget(item.entry) ?? item.target} → ${action === "keep" ? "保持现状并核对" : action === "audit" ? "放行并记录" : "拦截"}`,
          )
          .join("\n")
        outcome = await ctx.quickChange(
          `批量处理 ${changes.length} 项`,
          summary,
          document => applyCaseChoices(document, choices),
          mode,
        )
        if (!outcome) return
      }
      const kept = choices.filter(choice => choice.action === "keep").map(choice => choice.item)
      if (kept.length && outcome && !outcome.staged && outcome.revision) {
        setWaiting(true)
        if (!(await acknowledgeCasesAfterApply(kept, outcome.revision)))
          message.info("配置已提交，未核对项保留")
      } else if (kept.length) await acknowledgeCases(kept, snapshot.revision)
      if (!changes.length) message.success("已核对")
      onDone()
      onClose()
    } catch (error) {
      message.error((error as Error).message)
    } finally {
      setWorking(false)
      setWaiting(false)
    }
  }
  return (
    <Drawer
      title={`批量处理 · ${snapshot.cases.length} 项`}
      open={open}
      onClose={() => {
        if (!busy) onClose()
      }}
      closable={!busy}
      maskClosable={!busy}
      keyboard={!busy}
      size={720}
      styles={{ wrapper: { width: "min(720px, 100vw)" } }}
      footer={
        <Space wrap>
          <Button disabled={busy || !hasActions} onClick={() => void apply("draft")}>
            加入草稿
          </Button>
          <Button
            type="primary"
            loading={working || ctx.saving}
            disabled={
              busy ||
              !hasActions ||
              !snapshot.cases.length ||
              (snapshot.revision !== ctx.settingsRevision && !working)
            }
            onClick={() => void apply("apply")}
          >
            {ctx.dirty ? "加入现有草稿" : "应用所选动作"}
          </Button>
        </Space>
      }
    >
      <div className="page-stack">
        {waiting && <Alert type="info" title="等待配置生效后核对保留项" />}
        {snapshot.revision !== ctx.settingsRevision && !working && (
          <Alert
            type="warning"
            title="配置已变更，请重新选择待办"
            action={
              <Button
                onClick={() => {
                  onClose()
                  onDone()
                }}
              >
                刷新待办
              </Button>
            }
          />
        )}
        <Space wrap>
          <Button
            disabled={busy}
            onClick={() =>
              setActions(
                Object.fromEntries(
                  snapshot.cases.map(item => [item.id, caseProblem(item) ? "skip" : "audit"]),
                ),
              )
            }
          >
            放行可配置项
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              setActions(Object.fromEntries(snapshot.cases.map(item => [item.id, "keep"])))
            }
          >
            全部保持现状
          </Button>
        </Space>
        {snapshot.cases.map(item => (
          <section className="case-batch-item" key={item.id}>
            <strong>
              {item.plugin} · {operationName(item.operation)}
            </strong>
            <code>{siteShortcutTarget(item.entry) ?? item.target}</code>
            {siteShortcutTarget(item.entry) && <Tag>站点全部路径</Tag>}
            <Select
              aria-label={`${item.plugin} ${item.target} 处理动作`}
              value={actions[item.id] ?? "skip"}
              disabled={working || ctx.saving}
              onChange={action => setActions(old => ({ ...old, [item.id]: action }))}
              options={[
                { value: "skip", label: "暂不处理" },
                { value: "keep", label: "保持现状" },
                { value: "audit", label: "放行并记录", disabled: Boolean(caseProblem(item)) },
                { value: "deny", label: "拦截", disabled: Boolean(caseProblem(item)) },
              ]}
            />
            {caseProblem(item) && <span className="muted">{caseProblem(item)}</span>}
          </section>
        ))}
      </div>
    </Drawer>
  )
}
