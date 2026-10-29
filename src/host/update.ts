import fs from "node:fs"
import path from "node:path"
import type { GuardSettings } from "../shared/types.js"
import { M } from "../shared/messages.js"
import { inWindow } from "../shared/update-window.js"
import { compareVersions } from "../shared/version.js"
import { fetchRelease, gitBranch, gitSync, releaseBranch, versionAt } from "../update/git.js"
import { crossesMajor, fetchLatestRelease, isNewer, type ReleaseInfo } from "../update/release.js"
import {
  clearWork,
  stageCommit,
  stageRelease,
  swapPackage,
  workPaths,
  type StagedRelease,
} from "../update/install.js"
import { exportCommit } from "../update/git.js"
import { planUpdate, readManifest, type UpdateLevel, type UpdatePlan } from "../update/plan.js"

type UpdateSettings = GuardSettings["update"]
type Phase = "idle" | "downloading" | "installing" | "restarting" | "pending" | "failed"
/** 更新完成的方式：热替换、重启业务进程、宿主重新启动，或宿主仍需手动重启。 */
export type FinishMode = "hot" | "worker" | "relaunch" | "host-pending"

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
  /** 上一版本的发布文件或 Git 提交仍保留时可以还原。 */
  rollback?: { version: string }
  /** 最近一次更新的级别与改动文件数。 */
  plan?: { level: UpdateLevel; changed: number }
  /** 控制台已更新、等待重启业务进程生效的更新。 */
  pending?: { version: string; since: number; rollback: boolean }
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
  /** 把已暂存的发布包交给生命周期队列；immediate 为真时业务侧更新不等待空闲。 */
  install: (staged: StagedRelease, from: string, rollback: boolean, immediate: boolean) => void
  /** 取消等待中的更新：控制台回到当前文件。 */
  cancelPending: () => Promise<void>
  record: (type: string, details?: Record<string, unknown>) => void
}

/**
 * 判断等待中的业务侧更新是否到了执行时机：
 * now 立即；window 只在维护时段；idle 等业务连续空闲，超过最长等待后直接执行。
 */
export function pendingDue(input: {
  since: number
  settings: UpdateSettings
  lastActivityAt: number
  now: number
}): boolean {
  const { since, settings, lastActivityAt, now } = input
  if (settings.workerRestart === "now") return true
  if (settings.workerRestart === "window") return inWindow(settings.window, new Date(now))
  if (now - since >= settings.maxWaitHours * 3600_000) return true
  return now - lastActivityAt >= settings.idleSeconds * 1000
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
  /** 启动或提交更新时解析，避免状态查询反复执行 git show。 */
  #previousVersion: string | undefined
  #plan: UpdatePlan | undefined
  #pending: { staged: StagedRelease; from: string; since: number; rollback: boolean } | undefined
  readonly #verifyFile: string

  /** 载入持久化检查结果、待发通知与回滚目标，并解析上一版本。 */
  constructor(options: UpdateOptions) {
    this.#options = options
    this.#file = path.join(options.stateDir, "update.json")
    this.#verifyFile = path.join(options.stateDir, "update-verify.json")
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
        previousCommit:
          typeof value.previousCommit === "string" &&
          /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.previousCommit)
            ? value.previousCommit
            : undefined,
      }
    } catch {
      // 首次运行或文件损坏时从空状态开始。
    }
    if (this.#stored.previousCommit)
      this.#previousVersion = versionAt(options.pluginDir, this.#stored.previousCommit)
  }

  /** 读取轻量元数据与已解析的回滚版本，供面板、命令与 CLI 展示；不启动子进程。 */
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
      plan: this.#plan && { level: this.#plan.level, changed: this.#plan.changed.length },
      pending: this.#pending && {
        version: this.#pending.staged.version,
        since: this.#pending.since,
        rollback: this.#pending.rollback,
      },
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
   * 暂存最新发布、比较组件得出更新级别，再交给生命周期队列。force 允许重装当前版本或跨主版本升级，
   * 低于当前版本的发布仍拒绝；必须成功检查发布信息，不以旧缓存替代失败响应。
   * immediate 为真时，需要重启业务进程的更新马上执行，不等待空闲。
   * 已有等待生效的更新时，再次请求更新即视为要求马上生效。
   */
  async apply(force: boolean, immediate = false): Promise<{ ok: boolean; message: string }> {
    if (this.#pending) return this.applyPending()
    if (this.#busy) return { ok: false, message: M.update.busy }
    const state = this.state()
    if (!state.autoUpdate) return { ok: false, message: M.update.gitSource }
    this.#busy = true
    try {
      this.#phase = "downloading"
      this.#message = undefined
      await this.check(true)
      if (this.#error) throw new Error(this.#error)
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
          message: `已是最新版本 ${current}，如需重新安装请使用强制更新`,
        }
      }
      if (!force && crossesMajor(release.version, current))
        throw new Error(M.update.majorBlocked(current, release.version))
      this.#message = `正在下载 ${release.version}`
      const pluginDir = this.#options.pluginDir
      const staged =
        state.installMode === "git"
          ? await stageCommit(
              pluginDir,
              (await fetchRelease(pluginDir, release.version, force)).commit,
              release.version,
              (commit, file) => exportCommit(pluginDir, commit, file),
            )
          : await stageRelease(release, pluginDir, current)
      return this.#install(staged, current, false, immediate, force)
    } catch (error) {
      this.#fail((error as Error).message)
      return { ok: false, message: (error as Error).message }
    }
  }

  /** 比较组件、通知开始并排入生命周期队列。 */
  #install(
    staged: StagedRelease,
    current: string,
    rollback: boolean,
    immediate: boolean,
    force = false,
  ): { ok: boolean; message: string } {
    const plan = planUpdate(readManifest(this.#options.pluginDir), readManifest(staged.directory))
    this.#plan = plan
    const deferred =
      plan.level === "worker" && !immediate && this.#options.settings().workerRestart !== "now"
    const effect = {
      static: "本次仅更新 Web 控制台，机器人运行不受影响。",
      core: "Web 控制台将热替换，机器人运行不受影响。",
      worker: deferred
        ? "Web 控制台将先行更新，业务侧更新将在机器人空闲时生效；如需立即生效，请再次发送 #guard更新。"
        : "业务进程将重启一次。",
      host: "宿主将重新启动一次。",
    }[plan.level]
    const verb = rollback ? "还原" : "更新"
    this.#phase = "installing"
    this.#message = `正在${verb}至 ${staged.version}`
    this.#options.record(rollback ? "update-rollback-staged" : "update-staged", {
      from: current,
      to: staged.version,
      force,
      level: plan.level,
      changed: plan.changed.length,
      reason: plan.reason,
    })
    const text = `开始${verb}：${current} → ${staged.version}。${effect}`
    this.notify(`【Yunzai Guard】${text}`)
    this.#options.install({ ...staged, plan }, current, rollback, immediate)
    return { ok: true, message: text }
  }

  /** 读取保留的上一版本号；没有或不完整时返回 undefined。 */
  #previous(): { version: string } | undefined {
    if (fs.existsSync(path.join(this.#options.pluginDir, ".git"))) {
      const version = this.#previousVersion
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

  /** 把保留的上一版本复制为暂存包；Git 安装导出原提交。 */
  async #stagePrevious(version: string): Promise<StagedRelease> {
    const pluginDir = this.#options.pluginDir
    if (fs.existsSync(path.join(pluginDir, ".git"))) {
      const commit = this.#stored.previousCommit
      if (!commit) throw new Error(M.update.noPrevious)
      return stageCommit(pluginDir, commit, version, (target, file) =>
        exportCommit(pluginDir, target, file),
      )
    }
    const paths = workPaths(pluginDir)
    clearWork(pluginDir)
    fs.mkdirSync(paths.staged, { recursive: true })
    const directory = path.join(paths.staged, "yunzai-guard")
    // 调度失败会清理暂存目录，原备份须保留到真正替换文件时。
    fs.cpSync(paths.previous, directory, { recursive: true })
    return { version, directory }
  }

  /**
   * 还原到上一版本：同样按组件比较，能热替换时不重启。
   * 有等待生效的更新时，还原即取消这次更新，控制台回到当前文件。
   */
  async rollback(): Promise<{ ok: boolean; message: string }> {
    const pending = this.#pending
    if (pending) {
      this.#pending = undefined
      await this.#options.cancelPending()
      clearWork(this.#options.pluginDir)
      this.#busy = false
      this.#phase = "idle"
      this.#message = undefined
      this.#options.record("update-pending-cancelled", { version: pending.staged.version })
      return { ok: true, message: M.update.pendingCancelled(pending.staged.version) }
    }
    if (this.#busy) return { ok: false, message: M.update.busy }
    const state = this.state()
    if (!state.autoUpdate) return { ok: false, message: M.update.gitSource }
    const previous = this.#previous()
    if (!previous) return { ok: false, message: M.update.noPrevious }
    this.#busy = true
    try {
      const current = readVersion(this.#options.pluginDir)
      const staged = await this.#stagePrevious(previous.version)
      return this.#install(staged, current, true, true)
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
    // reset --hard 只改写内容变化的文件，热更新时同样可用。
    const directory = this.#options.pluginDir
    const before = gitSync(directory, ["rev-parse", "HEAD"])
    const previousVersion = versionAt(directory, before)
    gitSync(directory, ["reset", "--hard", "--quiet", staged.commit])
    return {
      rollback: () => {
        gitSync(directory, ["reset", "--hard", "--quiet", before])
      },
      commit: () => {
        this.#stored.previousCommit = before
        this.#previousVersion = previousVersion
        this.#save()
      },
    }
  }

  /** 业务侧更新改为等待：控制台已换成新版本，业务进程择时重启。 */
  defer(staged: StagedRelease, from: string, rollback: boolean): void {
    this.#pending = { staged, from, since: Date.now(), rollback }
    this.#phase = "pending"
    this.#message = undefined
    this.#options.record("update-deferred", { from, to: staged.version })
    this.notify(
      `【Yunzai Guard】Web 控制台已${rollback ? "还原" : "更新"}至 ${staged.version}，业务侧更新将在机器人空闲时生效；如需立即生效，请再次发送 #guard更新。`,
    )
  }

  /** 等待中的更新；用于判断是否到了执行时机。 */
  get pending(): { version: string; since: number } | undefined {
    return this.#pending && { version: this.#pending.staged.version, since: this.#pending.since }
  }

  /** 立即执行等待中的更新：重启业务进程使其生效。 */
  applyPending(): Promise<{ ok: boolean; message: string }> {
    const pending = this.#pending
    if (!pending) return Promise.resolve({ ok: false, message: M.update.noPending })
    this.#pending = undefined
    this.#phase = "installing"
    this.#options.record("update-pending-apply", { to: pending.staged.version })
    try {
      this.#options.install(pending.staged, pending.from, pending.rollback, true)
    } catch (error) {
      this.#pending = pending
      this.#phase = "pending"
      return Promise.resolve({ ok: false, message: (error as Error).message })
    }
    return Promise.resolve({ ok: true, message: M.update.pendingStarted })
  }

  /** 宿主重新启动前记录待确认的更新，新宿主上线后据此确认成功或还原。 */
  markVerify(value: { from: string; to: string; rollback: boolean; revert?: boolean }): void {
    fs.mkdirSync(this.#options.stateDir, { recursive: true })
    fs.writeFileSync(this.#verifyFile, JSON.stringify({ ...value, attempts: 0, at: Date.now() }), {
      mode: 0o600,
    })
  }

  /** 读取待确认的更新并累加启动次数；没有时返回 undefined。 */
  takeVerify():
    { from: string; to: string; rollback: boolean; revert: boolean; attempts: number } | undefined {
    try {
      const value = JSON.parse(fs.readFileSync(this.#verifyFile, "utf8")) as Record<string, unknown>
      if (typeof value.from !== "string" || typeof value.to !== "string") return undefined
      const attempts = (Number.isSafeInteger(value.attempts) ? Number(value.attempts) : 0) + 1
      fs.writeFileSync(this.#verifyFile, JSON.stringify({ ...value, attempts }), { mode: 0o600 })
      return {
        from: value.from,
        to: value.to,
        rollback: value.rollback === true,
        revert: value.revert === true,
        attempts,
      }
    } catch {
      return undefined
    }
  }

  /** 清除待确认记录。 */
  clearVerify(): void {
    fs.rmSync(this.#verifyFile, { force: true })
  }

  /** 新宿主上的更新未能上线：把保留的上一版本暂存起来用于还原。 */
  async stageRevert(version: string): Promise<StagedRelease> {
    this.#busy = true
    const staged = await this.#stagePrevious(version)
    return { ...staged, plan: { level: "host", changed: [] } }
  }

  /** 更新结束：记录结果并通知主人。 */
  finish(result: {
    ok: boolean
    from: string
    to: string
    message?: string
    mode: FinishMode
    rollback?: boolean
  }): void {
    const at = Date.now()
    this.#busy = false
    this.#pending = undefined
    clearWork(this.#options.pluginDir)
    this.#phase = result.ok ? "idle" : "failed"
    this.#hostRestartPending = result.ok && result.mode === "host-pending"
    this.#message = result.ok ? undefined : result.message
    const verb = result.rollback ? "还原" : "更新"
    const effect = {
      hot: "，机器人运行未中断。",
      worker: "，业务进程已重启。",
      relaunch: "，宿主已重新启动。",
      "host-pending": "，需重启宿主后完全生效。",
    }[result.mode]
    const text = result.ok
      ? `【Yunzai Guard】已${verb}至 ${result.to}（原版本 ${result.from}）${effect}`
      : `【Yunzai Guard】${verb}失败：${result.message ?? "原因未知"}。`
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
      mode: result.mode,
      message: result.message,
    })
    this.notify(text)
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
          `【Yunzai Guard】发现新版本 ${release.version}（当前版本 ${current}）`,
          brief(release.notes),
          "如需更新，请发送 #guard更新。",
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
