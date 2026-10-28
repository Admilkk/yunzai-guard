import fs from "node:fs"
import path from "node:path"
import type { GuardSettings } from "../shared/types.js"
import { M } from "../shared/messages.js"
import { compareVersions } from "../shared/version.js"
import { fetchRelease, gitBranch, gitSync, releaseBranch, versionAt } from "../update/git.js"
import { crossesMajor, fetchLatestRelease, isNewer, type ReleaseInfo } from "../update/release.js"
import {
  clearWork,
  stageRelease,
  swapPackage,
  workPaths,
  type StagedRelease,
} from "../update/install.js"

type UpdateSettings = GuardSettings["update"]
type Phase = "idle" | "downloading" | "installing" | "restarting" | "failed"

export interface UpdateSummary {
  version: string
  name: string
  notes: string
  url: string
  publishedAt: string
}

export interface UpdateState {
  current: string
  installMode: "release" | "git"
  /** Git 安装的分支；release 分支可自动更新，其他分支需手动更新。 */
  gitBranch?: string
  /** 能否由 Guard 自动更新与还原。 */
  autoUpdate: boolean
  enabled: boolean
  intervalMs: number
  checking: boolean
  checkedAt?: number
  error?: string
  latest?: UpdateSummary
  available: boolean
  phase: Phase
  message?: string
  hostRestartPending: boolean
  /** 上一版本仍保留在 .update/previous 时可以还原。 */
  rollback?: { version: string }
  lastResult?: { ok: boolean; version: string; message: string; at: number }
}

interface Stored {
  etag?: string
  checkedAt?: number
  release?: ReleaseInfo
  notified?: string
  pending: string[]
  /** Git 安装更新前的提交，用于还原。 */
  previousCommit?: string
  lastResult?: UpdateState["lastResult"]
}

interface UpdateOptions {
  /** 插件目录，更新只替换其中的发布文件。 */
  pluginDir: string
  stateDir: string
  /** 当前生效的更新配置，每次使用时读取以便即时生效。 */
  settings: () => UpdateSettings
  /** 立即送达主人；业务进程未上线时返回 false，消息留待上线后补发。 */
  send: (text: string) => boolean
  /** 把已暂存的发布包交给生命周期队列。 */
  install: (staged: StagedRelease, from: string, rollback?: boolean) => void
  record: (type: string, details?: Record<string, unknown>) => void
}

const firstCheckDelayMs = 15000
const maxPending = 5
const maxNoticeChars = 1500

/** 读取插件当前版本。 */
function readVersion(pluginDir: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8")) as {
      version?: unknown
    }
    return typeof parsed.version === "string" ? parsed.version : "unknown"
  } catch {
    return "unknown"
  }
}

/** 取更新说明的开头部分，去掉 Markdown 装饰。 */
function brief(notes: string): string {
  const lines = notes
    .replace(/\r/g, "")
    .split("\n")
    .map(line => line.replace(/^[#>*\-\s]+/, "").trim())
    .filter(Boolean)
  return lines.slice(0, 6).join("\n").slice(0, 400)
}

/**
 * 版本检查与更新编排：周期查询公开发布、通知主人、暂存发布包。
 * 文件替换由宿主生命周期队列在业务进程停止后执行。
 */
export class UpdateService {
  readonly #options: UpdateOptions
  readonly #file: string
  #stored: Stored = { pending: [] }
  #timer: NodeJS.Timeout | undefined
  #checking: Promise<void> | undefined
  #busy = false
  #stopped = false
  #phase: Phase = "idle"
  #message: string | undefined
  #error: string | undefined
  #hostRestartPending = false

  /** 载入上次保存的检查结果和待发通知。 */
  constructor(options: UpdateOptions) {
    this.#options = options
    this.#file = path.join(options.stateDir, "update.json")
    try {
      const value = JSON.parse(fs.readFileSync(this.#file, "utf8")) as Partial<Stored>
      this.#stored = {
        etag: typeof value.etag === "string" ? value.etag : undefined,
        checkedAt: typeof value.checkedAt === "number" ? value.checkedAt : undefined,
        release: value.release,
        notified: typeof value.notified === "string" ? value.notified : undefined,
        pending: Array.isArray(value.pending)
          ? value.pending
              .filter((item): item is string => typeof item === "string")
              .slice(-maxPending)
          : [],
        lastResult: value.lastResult,
      }
    } catch {
      // 首次运行或文件损坏时从空状态开始。
    }
  }

  /** 当前状态快照，供面板、命令与 CLI 展示。 */
  state(): UpdateState {
    const git = fs.existsSync(path.join(this.#options.pluginDir, ".git"))
    const branch = git ? gitBranch(this.#options.pluginDir) : undefined
    const settings = this.#options.settings()
    const current = readVersion(this.#options.pluginDir)
    const release = this.#stored.release
    return {
      current,
      installMode: git ? "git" : "release",
      gitBranch: branch,
      autoUpdate: !git || branch === releaseBranch,
      enabled: settings.check,
      intervalMs: settings.intervalMs,
      checking: Boolean(this.#checking),
      checkedAt: this.#stored.checkedAt,
      error: this.#error,
      latest: release && {
        version: release.version,
        name: release.name,
        notes: release.notes,
        url: release.url,
        publishedAt: release.publishedAt,
      },
      available: Boolean(release && isNewer(release.version, current)),
      phase: this.#phase,
      message: this.#message,
      hostRestartPending: this.#hostRestartPending,
      rollback: this.#previous(),
      lastResult: this.#stored.lastResult,
    }
  }

  /** 开始周期检查；首次检查稍后进行，避免与启动抢占资源。 */
  start(): void {
    this.#stopped = false
    this.#schedule(firstCheckDelayMs)
  }

  /** 停止周期检查。 */
  stop(): void {
    this.#stopped = true
    clearTimeout(this.#timer)
  }

  /** 补发留存的通知。 */
  flush(): void {
    if (!this.#stored.pending.length) return
    this.#stored.pending = this.#stored.pending.filter(text => !this.#options.send(text))
    this.#save()
  }

  /** 发送通知；业务进程不在线时留存，defer 为真时不尝试立即发送。 */
  notify(text: string, defer = false): void {
    const body = text.slice(0, maxNoticeChars)
    if (!defer && this.#options.send(body)) return
    this.#stored.pending = [...this.#stored.pending, body].slice(-maxPending)
    this.#save()
  }

  /** 检查最新版本；并发调用共用同一次请求。manual 为真时忽略 ETag 并无视关闭开关。 */
  check(manual = false): Promise<UpdateState> {
    if (!manual && !this.#options.settings().check) return Promise.resolve(this.state())
    this.#checking ??= this.#fetch(manual).finally(() => {
      this.#checking = undefined
    })
    return this.#checking.then(() => this.state())
  }

  /**
   * 暂存最新发布并交给生命周期队列。force 允许重装当前版本、跨主版本更新，
   * 并跳过版本比较。返回给调用方的文本即用户可见的结果。
   */
  async apply(force: boolean): Promise<{ ok: boolean; message: string }> {
    if (this.#busy) return { ok: false, message: M.update.busy }
    const state = this.state()
    if (!state.autoUpdate) return { ok: false, message: M.update.gitSource }
    this.#busy = true
    try {
      this.#phase = "downloading"
      this.#message = undefined
      await this.check(true)
      const release = this.#stored.release
      if (!release) throw new Error(this.#error ?? M.update.fetchFailed("无发布信息"))
      const current = state.current
      if ((compareVersions(release.version, current) ?? 0) < 0)
        throw new Error(M.update.downgrade(current, release.version))
      if (!force && !isNewer(release.version, current)) {
        this.#phase = "idle"
        this.#busy = false
        return {
          ok: false,
          message: `已是最新版本 ${current}（强制更新可重新安装 ${release.version}）`,
        }
      }
      if (!force && crossesMajor(release.version, current))
        throw new Error(M.update.majorBlocked(current, release.version))
      this.#message = `正在下载 ${release.version}`
      const staged =
        state.installMode === "git"
          ? {
              version: release.version,
              directory: this.#options.pluginDir,
              commit: (await fetchRelease(this.#options.pluginDir, release.version, force)).commit,
            }
          : await stageRelease(release, this.#options.pluginDir, current)
      this.#phase = "installing"
      this.#message = `正在安装 ${release.version}`
      this.#options.record("update-staged", { from: current, to: release.version, force })
      this.notify(`【Yunzai Guard】开始更新：${current} → ${release.version}，业务进程将重建`)
      this.#options.install(staged, current)
      return { ok: true, message: `开始更新：${current} → ${release.version}，业务进程将重建` }
    } catch (error) {
      this.#fail((error as Error).message)
      return { ok: false, message: (error as Error).message }
    }
  }

  /** 读取保留的上一版本号；没有或不完整时返回 undefined。 */
  #previous(): { version: string } | undefined {
    const commit = this.#stored.previousCommit
    if (fs.existsSync(path.join(this.#options.pluginDir, ".git"))) {
      const version = commit ? versionAt(this.#options.pluginDir, commit) : undefined
      return version ? { version } : undefined
    }
    try {
      const manifest = JSON.parse(
        fs.readFileSync(
          path.join(workPaths(this.#options.pluginDir).previous, "package.json"),
          "utf8",
        ),
      ) as { version?: unknown }
      return typeof manifest.version === "string" ? { version: manifest.version } : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 还原到上一版本：把保留的文件当作暂存包交给生命周期队列。
   * 还原后宿主与业务进程都必须用旧代码重新启动，所以不会在旧宿主里直接拉起业务进程。
   */
  async rollback(): Promise<{ ok: boolean; message: string }> {
    if (this.#busy) return { ok: false, message: M.update.busy }
    const state = this.state()
    if (!state.autoUpdate) return { ok: false, message: M.update.gitSource }
    const previous = this.#previous()
    if (!previous) return { ok: false, message: M.update.noPrevious }
    this.#busy = true
    if (state.installMode === "git") {
      const current = readVersion(this.#options.pluginDir)
      this.#phase = "installing"
      this.#message = `正在还原到 ${previous.version}`
      this.notify(`【Yunzai Guard】开始还原：${current} → ${previous.version}，宿主将重新启动`)
      this.#options.install(
        {
          version: previous.version,
          directory: this.#options.pluginDir,
          commit: this.#stored.previousCommit,
        },
        current,
        true,
      )
      return { ok: true, message: `开始还原：${current} → ${previous.version}` }
    }
    try {
      const paths = workPaths(this.#options.pluginDir)
      clearWork(this.#options.pluginDir)
      fs.mkdirSync(paths.staged, { recursive: true })
      const directory = path.join(paths.staged, "yunzai-guard")
      fs.renameSync(paths.previous, directory)
      const current = readVersion(this.#options.pluginDir)
      this.#phase = "installing"
      this.#message = `正在还原到 ${previous.version}`
      this.notify(`【Yunzai Guard】开始还原：${current} → ${previous.version}，宿主将重新启动`)
      this.#options.install({ version: previous.version, directory }, current, true)
      return { ok: true, message: `开始还原：${current} → ${previous.version}` }
    } catch (error) {
      this.#fail((error as Error).message)
      return { ok: false, message: (error as Error).message }
    }
  }

  /** 由生命周期队列在业务进程停止后调用，执行文件替换。 */
  swap(staged: StagedRelease): ReturnType<typeof swapPackage> {
    this.#phase = "restarting"
    this.#message = M.update.restarting(staged.version)
    if (!staged.commit) return swapPackage(staged, this.#options.pluginDir)
    // Git 安装：切换到目标提交；还原时切回原提交，完成后记录原提交供之后还原。
    const directory = this.#options.pluginDir
    const before = gitSync(directory, ["rev-parse", "HEAD"])
    gitSync(directory, ["reset", "--hard", "--quiet", staged.commit])
    return {
      rollback: () => {
        gitSync(directory, ["reset", "--hard", "--quiet", before])
      },
      commit: () => {
        this.#stored.previousCommit = before
        this.#save()
      },
    }
  }

  /** 更新结束：记录结果并通知主人；defer 为真时留待新宿主上线后发送。 */
  finish(result: {
    ok: boolean
    from: string
    to: string
    message?: string
    relaunch: boolean
    rollback?: boolean
  }): void {
    const at = Date.now()
    this.#busy = false
    clearWork(this.#options.pluginDir)
    this.#phase = result.ok ? "idle" : "failed"
    this.#hostRestartPending = result.ok && !result.relaunch
    this.#message = result.ok ? undefined : result.message
    const verb = result.rollback ? "还原" : "更新"
    const text = result.ok
      ? `【Yunzai Guard】已${result.rollback ? "还原到" : "更新到"} ${result.to}（原 ${result.from}）${
          result.relaunch ? "，宿主已重新启动" : "；宿主进程需重启后完全生效，重启前面板仍为旧版本"
        }`
      : `【Yunzai Guard】${verb}失败：${result.message ?? "未知原因"}`
    this.#stored.lastResult = {
      ok: result.ok,
      version: result.to,
      message: result.ok ? `${verb}成功` : (result.message ?? `${verb}失败`),
      at,
    }
    this.#save()
    this.#options.record(result.ok ? "update-complete" : "update-failed", {
      from: result.from,
      to: result.to,
      message: result.message,
    })
    this.notify(text, result.ok && result.relaunch)
  }

  /** 记录暂存阶段的失败；结果文本由调用方回复给发起人。 */
  #fail(message: string): void {
    this.#busy = false
    this.#phase = "failed"
    this.#message = message
    this.#options.record("update-failed", { message })
    clearWork(this.#options.pluginDir)
  }

  /** 安排下一次检查。 */
  #schedule(delay: number): void {
    clearTimeout(this.#timer)
    if (this.#stopped) return
    this.#timer = setTimeout(() => {
      void this.check().finally(() => this.#schedule(this.#options.settings().intervalMs))
    }, delay)
    this.#timer.unref()
  }

  /** 查询发布并在发现未通知过的新版本时提醒主人。 */
  async #fetch(manual: boolean): Promise<void> {
    const current = readVersion(this.#options.pluginDir)
    try {
      const result = await fetchLatestRelease(current, manual ? undefined : this.#stored.etag)
      if (result.release) this.#stored.release = result.release
      this.#stored.etag = result.etag
      this.#stored.checkedAt = Date.now()
      this.#error = undefined
    } catch (error) {
      this.#error = (error as Error).message
      this.#options.record("update-check-failed", { message: this.#error })
      return
    }
    const release = this.#stored.release
    if (
      release &&
      isNewer(release.version, current) &&
      this.#stored.notified !== release.version &&
      this.#options.settings().notify
    ) {
      this.#stored.notified = release.version
      this.#options.record("update-available", { current, latest: release.version })
      this.notify(
        [
          `【Yunzai Guard】发现新版本 ${release.version}（当前 ${current}）`,
          brief(release.notes),
          "发送 #guard更新 立即更新，或在控制台「总览」页操作。",
          release.url,
        ]
          .filter(Boolean)
          .join("\n"),
      )
    }
    this.#save()
  }

  /** 保存状态；写入失败只影响跨重启的去重与补发。 */
  #save(): void {
    try {
      fs.mkdirSync(this.#options.stateDir, { recursive: true })
      fs.writeFileSync(this.#file, JSON.stringify(this.#stored), { mode: 0o600 })
    } catch {
      // 状态文件不可写时仅丢失缓存，不影响更新流程。
    }
  }
}
