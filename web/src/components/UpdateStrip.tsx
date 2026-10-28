import { useEffect, useState } from "react"
import { App, Button, Space, Tag, Typography } from "antd"
import { CloudDownloadOutlined, SyncOutlined } from "@ant-design/icons"
import { api } from "../api"
import { relativeTime } from "../components"
import { useConsole } from "../state"

type Update = {
  current: string
  installMode: "release" | "git"
  gitBranch?: string
  autoUpdate: boolean
  enabled: boolean
  checking: boolean
  checkedAt?: number
  error?: string
  latest?: { version: string; name: string; notes: string; url: string }
  available: boolean
  phase: "idle" | "downloading" | "installing" | "restarting" | "failed"
  message?: string
  hostRestartPending: boolean
  rollback?: { version: string }
  lastResult?: { ok: boolean; version: string; message: string; at: number }
}

const busyPhases = new Set(["downloading", "installing", "restarting"])

/** 取更新说明开头几行，去掉 Markdown 装饰。 */
function brief(notes: string): string {
  return notes
    .split(/\r?\n/)
    .map(line => line.replace(/^[#>*\-\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 4)
    .join("\n")
}

/** 总览页的版本与更新条：检查、查看说明、一键更新或强制重装。 */
export function UpdateStrip() {
  const { overview, reload, connected, saving } = useConsole()
  const { message, modal } = App.useApp()
  const update = overview?.update as Update | undefined
  const [pending, setPending] = useState(false)
  const busy = pending || Boolean(update && busyPhases.has(update.phase))

  useEffect(() => {
    if (!update || !busyPhases.has(update.phase)) return
    const timer = setInterval(() => void reload(true).catch(() => {}), 2000)
    return () => clearInterval(timer)
  }, [update?.phase, reload])

  if (!update) return null
  const git = !update.autoUpdate

  /** 手动检查最新版本。 */
  async function check() {
    setPending(true)
    try {
      await api("/api/update/check", { method: "POST", body: "{}" })
      await reload(true)
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "检查失败")
    } finally {
      setPending(false)
    }
  }

  /** 提交更新；成功后业务进程会短暂重建。 */
  async function apply(force: boolean) {
    setPending(true)
    try {
      const result = await api("/api/update/apply", {
        method: "POST",
        body: JSON.stringify({ force }),
      })
      if (result.ok) message.success(result.message)
      else message.warning(result.message)
      await reload(true)
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "更新失败")
    } finally {
      setPending(false)
    }
  }

  /** 还原到上一版本：宿主会用旧文件重新启动。 */
  function confirmRollback() {
    const target = update?.rollback?.version ?? ""
    modal.confirm({
      title: `还原到 ${target}？`,
      content: "宿主将重新启动，launcher 方式需手动启动。",
      okText: "还原",
      cancelText: "取消",
      onOk: async () => {
        setPending(true)
        try {
          const result = await api("/api/update/rollback", { method: "POST", body: "{}" })
          if (result.ok) message.success(result.message)
          else message.warning(result.message)
          await reload(true)
        } catch (reason) {
          message.error(reason instanceof Error ? reason.message : "还原失败")
        } finally {
          setPending(false)
        }
      },
    })
  }

  /** 更新前确认；说明业务进程将重建。 */
  function confirm(force: boolean) {
    const target = update?.latest?.version ?? ""
    modal.confirm({
      title: force ? `强制重新安装 ${target}？` : `更新到 ${target}？`,
      content: (
        <div className="update-confirm">
          <p>
            {git || update?.installMode !== "git"
              ? "将下载并校验后替换文件"
              : "将拉取 release 分支"}
            ，业务进程随后重启；启动失败时自动还原。
          </p>
          {!force && update?.latest?.notes && (
            <Typography.Paragraph type="secondary" className="update-notes">
              {brief(update.latest.notes)}
            </Typography.Paragraph>
          )}
        </div>
      ),
      okText: force ? "强制更新" : "立即更新",
      cancelText: "取消",
      onOk: () => apply(force),
    })
  }

  const tone =
    update.phase === "failed" || update.error ? "warning" : update.available ? "info" : "ok"
  return (
    <section className={`update-strip ${tone}`}>
      <div className="update-strip-main">
        <CloudDownloadOutlined className="update-strip-icon" />
        <div>
          <strong>
            {busy
              ? (update.message ?? "正在更新")
              : update.available
                ? `发现新版本 ${update.latest?.version}`
                : `当前版本 ${update.current}`}
            {update.hostRestartPending && <Tag color="warning">宿主需重启后完全生效</Tag>}
          </strong>
          <span>
            {update.available
              ? `当前 ${update.current}`
              : update.enabled
                ? "已是最新版本"
                : "自动检查已关闭"}
            {" · "}
            {update.error
              ? `检查失败：${update.error}`
              : `上次检查 ${relativeTime(update.checkedAt)}`}
            {update.phase === "failed" && update.message ? ` · 更新失败：${update.message}` : ""}
            {update.installMode === "git" && update.autoUpdate
              ? ` · Git 安装（${update.gitBranch} 分支）`
              : ""}
            {git ? " · 源码安装需手动更新" : ""}
          </span>
        </div>
      </div>
      <Space size={8} wrap>
        {update.latest?.url && (
          <Button
            type="link"
            size="small"
            href={update.latest.url}
            target="_blank"
            rel="noreferrer"
          >
            更新说明
          </Button>
        )}
        <Button
          size="small"
          icon={<SyncOutlined spin={update.checking} />}
          disabled={!connected || busy}
          onClick={() => void check()}
        >
          检查更新
        </Button>
        {!git && update.rollback && (
          <Button size="small" disabled={!connected || saving || busy} onClick={confirmRollback}>
            还原 {update.rollback.version}
          </Button>
        )}
        {!git && update.latest && (
          <Button
            size="small"
            disabled={!connected || saving || busy}
            onClick={() => confirm(true)}
          >
            强制更新
          </Button>
        )}
        {!git && update.available && (
          <Button
            size="small"
            type="primary"
            disabled={!connected || saving || busy}
            loading={busy}
            onClick={() => confirm(false)}
          >
            立即更新
          </Button>
        )}
      </Space>
    </section>
  )
}
