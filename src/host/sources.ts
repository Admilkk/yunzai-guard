import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import type { GuardSettings } from "../shared/types.js"
import { matchGlob } from "../config/policy.js"

export interface PluginSource {
  plugin: string
  git: boolean
  remote?: string
  branch?: string
  commit?: string
  /** 工作区中已修改的受跟踪文件数。 */
  dirty?: number
  dirtyFiles?: string[]
  scannedAt: number
  error?: string
}

export interface SourceChange {
  plugin: string
  type: "commit" | "dirty" | "remote"
  text: string
}

interface Stored {
  commit?: string
  remote?: string
  dirty?: number
}

interface SourceOptions {
  pluginsDir: string
  stateDir: string
  settings: () => GuardSettings["sources"]
  onChange: (change: SourceChange) => void
}

const gitTimeoutMs = 8000
const maxDirtyFiles = 20

/** 去掉远端地址中的账号口令，避免展示或记录凭据。 */
export function cleanRemote(value: string): string {
  return value.replace(/\/\/[^/@\s]+@/, "//")
}

/** 在插件目录里执行一条 git 命令；失败返回 undefined。 */
function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(
      "git",
      ["-c", "safe.directory=*", ...args],
      {
        cwd,
        timeout: gitTimeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout) => resolve(error ? undefined : String(stdout).trimEnd()),
    )
  })
}

/**
 * 插件来源校验：定期读取 plugins 下各 Git 插件的远端、提交与工作区状态，
 * 与上次记录比较，发现被改动或来源变化时通知。只读，不执行插件代码。
 */
export class SourceWatch {
  readonly #options: SourceOptions
  readonly #file: string
  #stored: Record<string, Stored> = {}
  #sources: PluginSource[] = []
  #timer: NodeJS.Timeout | undefined
  #scanning: Promise<PluginSource[]> | undefined
  #stopped = false

  /** 读取上次保存的来源记录。 */
  constructor(options: SourceOptions) {
    this.#options = options
    this.#file = path.join(options.stateDir, "sources.json")
    try {
      this.#stored = JSON.parse(fs.readFileSync(this.#file, "utf8")) as Record<string, Stored>
    } catch {
      // 首次运行。
    }
  }

  /** 最近一次扫描结果。 */
  list(): PluginSource[] {
    return this.#sources
  }

  /** 开始周期扫描。 */
  start(): void {
    this.#stopped = false
    this.#schedule(5000)
  }

  /** 停止周期扫描。 */
  stop(): void {
    this.#stopped = true
    clearTimeout(this.#timer)
  }

  /** 安排下一次扫描。 */
  #schedule(delay: number): void {
    clearTimeout(this.#timer)
    if (this.#stopped) return
    this.#timer = setTimeout(() => {
      const config = this.#options.settings()
      void (config.enabled ? this.scan() : Promise.resolve([])).finally(() =>
        this.#schedule(this.#options.settings().intervalMs),
      )
    }, delay)
    this.#timer.unref()
  }

  /** 立即扫描；并发调用共用同一次扫描。 */
  scan(): Promise<PluginSource[]> {
    this.#scanning ??= this.#run().finally(() => {
      this.#scanning = undefined
    })
    return this.#scanning
  }

  /** 扫描每个插件目录并比较变化。 */
  async #run(): Promise<PluginSource[]> {
    const config = this.#options.settings()
    let names: string[] = []
    try {
      names = fs
        .readdirSync(this.#options.pluginsDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
        .map(entry => entry.name)
    } catch {
      // plugins 目录不存在。
    }
    const result: PluginSource[] = []
    for (const plugin of names.sort()) {
      if (config.ignore.some(pattern => matchGlob(pattern, plugin))) continue
      const directory = path.join(this.#options.pluginsDir, plugin)
      const scannedAt = Date.now()
      if (!fs.existsSync(path.join(directory, ".git"))) {
        result.push({ plugin, git: false, scannedAt })
        continue
      }
      const commit = await git(directory, ["rev-parse", "HEAD"])
      if (!commit) {
        result.push({
          plugin,
          git: true,
          scannedAt,
          error: "无法读取 Git 状态（未安装 git 或仓库损坏）",
        })
        continue
      }
      const [remote, branch, status] = await Promise.all([
        git(directory, ["config", "--get", "remote.origin.url"]),
        git(directory, ["rev-parse", "--abbrev-ref", "HEAD"]),
        git(directory, ["status", "--porcelain", "--untracked-files=no"]),
      ])
      const files = (status ?? "").split("\n").filter(Boolean)
      result.push({
        plugin,
        git: true,
        remote: remote ? cleanRemote(remote) : undefined,
        branch,
        commit,
        dirty: files.length,
        dirtyFiles: files.slice(0, maxDirtyFiles).map(line => line.slice(3)),
        scannedAt,
      })
    }
    this.#compare(result)
    this.#sources = result
    return result
  }

  /** 与上次记录比较，按配置通知并更新记录。 */
  #compare(current: PluginSource[]): void {
    const notify = this.#options.settings().notify
    const next: Record<string, Stored> = {}
    for (const item of current) {
      if (!item.git || !item.commit) continue
      const before = this.#stored[item.plugin]
      next[item.plugin] = { commit: item.commit, remote: item.remote, dirty: item.dirty }
      if (!before) continue
      if (notify.remote && before.remote !== item.remote)
        this.#options.onChange({
          plugin: item.plugin,
          type: "remote",
          text: `插件 ${item.plugin} 的远端地址变了：${before.remote ?? "无"} → ${item.remote ?? "无"}`,
        })
      if (notify.commit && before.commit !== item.commit)
        this.#options.onChange({
          plugin: item.plugin,
          type: "commit",
          text: `插件 ${item.plugin} 的提交变了：${before.commit?.slice(0, 8)} → ${item.commit.slice(0, 8)}`,
        })
      if (notify.dirty && !before.dirty && item.dirty)
        this.#options.onChange({
          plugin: item.plugin,
          type: "dirty",
          text: `插件 ${item.plugin} 有 ${item.dirty} 个文件与仓库不一致：${(item.dirtyFiles ?? []).slice(0, 3).join("、")}`,
        })
    }
    this.#stored = next
    try {
      fs.mkdirSync(this.#options.stateDir, { recursive: true })
      fs.writeFileSync(this.#file, JSON.stringify(next), { mode: 0o600 })
    } catch {
      // 记录写入失败时，下次扫描会重复提示一次变化。
    }
  }
}
