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
const statusConfig = new Set([
  "core.autocrlf",
  "core.eol",
  "core.filemode",
  "core.ignorecase",
  "core.ignorestat",
  "core.symlinks",
  "core.trustctime",
  "core.checkstat",
  "core.precomposeunicode",
])

/** 去掉远端地址中的账号口令，避免展示或记录凭据。 */
export function cleanRemote(value: string): string {
  try {
    const url = new URL(value)
    url.username = url.password = url.search = url.hash = ""
    return url.href
  } catch {
    return value.replace(/\/\/[^\s]*@/, "//")
  }
}

/** 执行受限的 Git 元数据命令，禁止钩子、懒加载与网络协议；失败返回 undefined。 */
function git(
  cwd: string,
  args: string[],
  overrides: NodeJS.ProcessEnv = {},
): Promise<string | undefined> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  )
  return new Promise(resolve => {
    execFile(
      "git",
      [
        "--no-pager",
        "--no-optional-locks",
        "-c",
        "safe.directory=*",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "protocol.allow=never",
        ...args,
      ],
      {
        cwd,
        timeout: gitTimeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: {
          ...env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_NO_LAZY_FETCH: "1",
          GIT_ALLOW_PROTOCOL: "",
          ...overrides,
        },
      },
      (error, stdout) => resolve(error ? undefined : String(stdout).trimEnd()),
    )
  })
}

/** 解析 Git 的 NUL 分隔配置输出；配置值只作为数据，不复制过滤器等可执行设置。 */
function configEntries(value: string): Map<string, string> {
  return new Map(
    value
      .split("\0")
      .filter(item => item.includes("\n"))
      .map(item => {
        const separator = item.indexOf("\n")
        return [item.slice(0, separator), item.slice(separator + 1)]
      }),
  )
}

/**
 * 在宿主私有 Git 视图中比较工作区，只借用原索引和对象库。
 * 不读取插件配置、钩子或过滤器定义，避免来源检查在系统沙箱外执行插件命令。
 */
async function safeStatus(
  directory: string,
  gitDirectory: string,
  commonDirectory: string,
  commit: string,
  config: Map<string, string>,
  stateDir: string,
): Promise<string | undefined> {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const base = fs.realpathSync(stateDir)
  const view = fs.mkdtempSync(path.join(base, "source-scan-"))
  try {
    fs.mkdirSync(path.join(view, "objects"))
    fs.mkdirSync(path.join(view, "refs"))
    fs.writeFileSync(path.join(view, "HEAD"), `${commit}\n`, { mode: 0o600 })
    const configuration = path.join(view, "config")
    fs.writeFileSync(
      configuration,
      commit.length === 64
        ? "[core]\nrepositoryformatversion = 1\nbare = false\n[extensions]\nobjectFormat = sha256\n"
        : "[core]\nrepositoryformatversion = 0\nbare = false\n",
      { mode: 0o600 },
    )
    const options = [...config].flatMap(([key, value]) =>
      statusConfig.has(key) ? ["-c", `${key}=${value}`] : [],
    )
    return await git(
      view,
      [...options, "status", "--porcelain", "--untracked-files=no", "--ignore-submodules=all"],
      {
        GIT_DIR: view,
        GIT_COMMON_DIR: view,
        GIT_WORK_TREE: directory,
        GIT_INDEX_FILE: path.join(gitDirectory, "index"),
        GIT_OBJECT_DIRECTORY: path.join(commonDirectory, "objects"),
        GIT_CONFIG_GLOBAL: configuration,
        GIT_CONFIG_SYSTEM: configuration,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ATTR_NOSYSTEM: "1",
      },
    )
  } finally {
    if (path.dirname(fs.realpathSync(view)) === base)
      fs.rmSync(view, { recursive: true, force: true })
  }
}

/**
 * 插件来源校验：定期读取 plugins 下各 Git 插件的远端、提交与工作区状态，
 * 与上次记录比较，发现被改动或来源变化时通知。只读，不执行插件代码。
 */
export class SourceWatch {
  readonly #options: SourceOptions
  readonly #file: string
  #stored: Record<string, Stored> = Object.create(null)
  #sources: PluginSource[] = []
  #timer: NodeJS.Timeout | undefined
  #scanning: Promise<PluginSource[]> | undefined
  #stopped = false

  /** 读取上次保存的来源记录。 */
  constructor(options: SourceOptions) {
    this.#options = options
    this.#file = path.join(options.stateDir, "sources.json")
    try {
      const value = JSON.parse(fs.readFileSync(this.#file, "utf8"))
      if (value && typeof value === "object" && !Array.isArray(value))
        Object.assign(this.#stored, value)
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
      const metadata = await git(directory, [
        "rev-parse",
        "--absolute-git-dir",
        "--git-common-dir",
        "HEAD",
        "--abbrev-ref",
        "HEAD",
      ])
      const [gitDirectory, commonPath, commit, branch] = metadata?.split(/\r?\n/) ?? []
      if (
        !gitDirectory ||
        !commonPath ||
        !commit ||
        !path.isAbsolute(gitDirectory) ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)
      ) {
        result.push({
          plugin,
          git: true,
          scannedAt,
          error: "无法读取 Git 状态（未安装 git 或仓库损坏）",
        })
        continue
      }
      const configuration = await git(directory, ["config", "--null", "--list", "--includes"])
      const gitConfiguration = configEntries(configuration ?? "")
      const remote =
        configuration === undefined
          ? this.#stored[plugin]?.remote
          : gitConfiguration.get("remote.origin.url")
      const status =
        configuration === undefined
          ? undefined
          : await safeStatus(
              directory,
              gitDirectory,
              path.resolve(directory, commonPath),
              commit,
              gitConfiguration,
              this.#options.stateDir,
            ).catch(() => undefined)
      const files = (status ?? "").split("\n").filter(Boolean)
      result.push({
        plugin,
        git: true,
        remote: remote ? cleanRemote(remote) : undefined,
        branch,
        commit,
        dirty: status === undefined ? undefined : files.length,
        dirtyFiles: files.slice(0, maxDirtyFiles).map(line => line.slice(3)),
        scannedAt,
        ...(status === undefined ? { error: "无法安全读取 Git 工作区状态" } : {}),
      })
    }
    this.#compare(result)
    this.#sources = result
    return result
  }

  /** 与上次记录比较，按配置通知并更新记录。 */
  #compare(current: PluginSource[]): void {
    const notify = this.#options.settings().notify
    const next: Record<string, Stored> = Object.create(null)
    for (const item of current) {
      if (!item.git || !item.commit) continue
      const before = this.#stored[item.plugin]
      next[item.plugin] = {
        commit: item.commit,
        remote: item.remote,
        dirty: item.dirty ?? before?.dirty,
      }
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
