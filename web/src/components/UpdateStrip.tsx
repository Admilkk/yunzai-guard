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
  phase: "idle" | "downloading" | "installing" | "restarting" | "pending" | "failed"
  message?: string
  hostRestartPending: boolean
  rollback?: { version: string }
  lastResult?: { ok: boolean; version: string; message: string; at: number }
  plan?: { level: "static" | "core" | "worker" | "host"; changed: number }
  pending?: { version: string; since: number; rollback: boolean }
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
    if (!update || (!busyPhases.has(update.phase) && update.phase !== "pending")) return
    const timer = setInterval(
      () => void reload(true).catch(() => {}),
      update.phase === "pending" ? 5000 : 2000,
    )
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

  /** 让等待中的业务侧更新马上生效：重启业务进程一次。 */
  async function applyPending() {
    setPending(true)
    try {
      const result = await api("/api/update/apply-pending", { method: "POST", body: "{}" })
      if (result.ok) message.success(result.message)
      else message.warning(result.message)
      await reload(true)
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "执行失败")
    } finally {
      setPending(false)
    }
  }

  /** 取消等待中的更新：控制台回到当前版本，业务进程不受影响。 */
  async function cancelPending() {
    setPending(true)
    try {
      const result = await api("/api/update/rollback", { method: "POST", body: "{}" })
      if (result.ok) message.success(result.message)
      else message.warning(result.message)
      await reload(true)
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "取消失败")
    } finally {
      setPending(false)
    }
  }

  /** 还原到上一版本：同样按改动范围处理，能热替换的部分不中断业务。 */
  function confirmRollback() {
    const target = update?.rollback?.version ?? ""
    modal.confirm({
      title: `还原到 ${target}？`,
      content:
        "按改动范围还原：控制台与宿主的部分热替换，涉及业务进程时重启一次；宿主需要重新启动时，launcher 方式需手动启动。",
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
            {git || update?.installMode !== "git" ? "将下载并校验新版本" : "将拉取 release 分支"}
            。控制台与宿主的改动热替换生效，涉及业务进程的改动按设置择时重启一次；新版本无法上线时自动还原。
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

  const waiting = update.phase === "pending" && update.pending
  const tone =
    update.phase === "failed" || update.error
      ? "warning"
      : update.available || waiting
        ? "info"
        : "ok"
  return (
    <section className={`update-strip ${tone}`}>
      <div className="update-strip-main">
        <CloudDownloadOutlined className="update-strip-icon" />
        <div>
          <strong>
            {busy
              ? (update.message ?? "正在更新")
              : waiting
                ? `${update.pending!.version} 等待生效`
                : update.available
                  ? `发现新版本 ${update.latest?.version}`
                  : `当前版本 ${update.current}`}
            {update.hostRestartPending && <Tag color="warning">宿主需重启后完全生效</Tag>}
          </strong>
          <span>
            {waiting && (
              <>
                控制台已是新版本，业务侧更新将按设置择时生效（
                {relativeTime(update.pending!.since)}开始等待）{" · "}
              </>
            )}
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
            {git ? " · 源码安装需在插件目录执行 git pull 与 npm ci --include=dev" : ""}
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
        {waiting && (
          <Button
            size="small"
            type="primary"
            disabled={!connected || saving || busy}
            loading={busy}
            onClick={() => void applyPending()}
          >
            马上生效
          </Button>
        )}
        {!git && (update.rollback || waiting) && (
          <Button
            size="small"
            disabled={!connected || saving || busy}
            onClick={waiting ? () => void cancelPending() : confirmRollback}
          >
            {waiting ? "取消更新" : `还原 ${update.rollback?.version}`}
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
        {!git && update.available && !waiting && (
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
