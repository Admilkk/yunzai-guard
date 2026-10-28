import fs from "node:fs"
import path from "node:path"
import { M } from "../shared/messages.js"

/**
 * 更新级别，按影响从小到大：
 * - static：只有控制台前端，替换文件即可
 * - core：控制台服务线程，宿主内换线程，业务不中断
 * - worker：Yunzai 进程内的代码，需要重启业务进程一次
 * - host：宿主外壳或原生程序，需要整个宿主重新启动
 */
export type UpdateLevel = "static" | "core" | "worker" | "host"
export type ComponentRole = "shell" | "worker" | "core" | "static" | "meta"

export interface ComponentManifest {
  schema: 1
  version: string
  files: Record<string, { sha256: string; roles: ComponentRole[] }>
}

export interface UpdatePlan {
  level: UpdateLevel
  /** 内容变化、新增或删除的文件（相对插件目录）。 */
  changed: string[]
  /** 判定为 host 级别的原因：缺少组件清单时无法比较。 */
  reason?: "manifest-missing"
}

export const manifestFile = "dist/components.json"
const levels: UpdateLevel[] = ["static", "core", "worker", "host"]
/**
 * 只含提示文案的模块：宿主与业务进程继续使用旧文案不影响行为，
 * 改动它不会升级为重启，下次自然重启后生效。
 */
const textOnly = new Set(["dist/shared/messages.js"])
const sha256Pattern = /^[a-f0-9]{64}$/
const rolePattern = new Set<ComponentRole>(["shell", "worker", "core", "static", "meta"])

/** 读取并校验组件清单；缺失或格式不符时返回 undefined。 */
export function readManifest(directory: string): ComponentManifest | undefined {
  let value: unknown
  try {
    value = JSON.parse(fs.readFileSync(path.join(directory, manifestFile), "utf8"))
  } catch {
    return undefined
  }
  if (!value || typeof value !== "object") return undefined
  const manifest = value as Partial<ComponentManifest>
  if (manifest.schema !== 1 || typeof manifest.version !== "string") return undefined
  if (!manifest.files || typeof manifest.files !== "object") return undefined
  for (const [file, entry] of Object.entries(manifest.files)) {
    if (!safeRelative(file)) return undefined
    if (!entry || typeof entry.sha256 !== "string" || !sha256Pattern.test(entry.sha256))
      return undefined
    if (!Array.isArray(entry.roles) || !entry.roles.length) return undefined
    if (!entry.roles.every(role => rolePattern.has(role))) return undefined
  }
  return manifest as ComponentManifest
}

/** 清单中的路径必须是插件目录内的相对路径。 */
function safeRelative(file: string): boolean {
  if (!file || file.length > 500 || file.includes("\\") || file.startsWith("/")) return false
  return !file.split("/").some(part => part === "" || part === "." || part === "..")
}

/** 取较高的级别。 */
function higher(a: UpdateLevel, b: UpdateLevel): UpdateLevel {
  return levels.indexOf(a) >= levels.indexOf(b) ? a : b
}

/** 判断一个改动文件至少需要的级别。 */
function levelOf(file: string, roles: Set<ComponentRole>): UpdateLevel | undefined {
  if (roles.has("shell") && !textOnly.has(file)) return "host"
  if (roles.has("worker") && !textOnly.has(file)) return "worker"
  if (roles.has("core")) return "core"
  if (roles.has("static")) return "static"
  return undefined
}

/** 比较新旧组件清单，得出本次更新需要的最低级别。 */
export function planUpdate(
  current: ComponentManifest | undefined,
  next: ComponentManifest | undefined,
): UpdatePlan {
  if (!current || !next) {
    const changed = next ? Object.keys(next.files) : []
    return { level: "host", changed, reason: "manifest-missing" }
  }
  let level: UpdateLevel = "static"
  const changed: string[] = []
  for (const file of new Set([...Object.keys(current.files), ...Object.keys(next.files)])) {
    const before = current.files[file]
    const after = next.files[file]
    if (before?.sha256 === after?.sha256) continue
    changed.push(file)
    const roles = new Set<ComponentRole>([...(before?.roles ?? []), ...(after?.roles ?? [])])
    const needed = levelOf(file, roles)
    if (needed) level = higher(level, needed)
  }
  return { level, changed: changed.sort() }
}

/** 比较级别高低。 */
export function atLeastLevel(value: UpdateLevel, minimum: UpdateLevel): boolean {
  return levels.indexOf(value) >= levels.indexOf(minimum)
}

export interface HotSync {
  /** 还原被覆盖与删除的文件。 */
  rollback(): void
}

/**
 * 逐个文件热替换：只改动清单中变化的文件，其余运行中的文件保持原样。
 * 新文件先写到同目录临时文件再改名覆盖，原文件移到备份目录，失败时全部还原。
 */
export function syncFiles(
  stagedDir: string,
  pluginDir: string,
  files: string[],
  backupDir: string,
): HotSync {
  const undo: Array<() => void> = []
  const rollback = (): void => {
    for (const step of undo.reverse()) {
      try {
        step()
      } catch {
        // 单项还原失败不阻止其余项还原。
      }
    }
    undo.length = 0
  }
  // 清单本身不在清单中，但必须随文件一起更新，否则下次比较会基于旧清单。
  const targets = [...new Set([...files, manifestFile, "package.json"])]
  try {
    for (const file of targets) {
      if (!safeRelative(file)) throw new Error(M.update.packageInvalid(file))
      const source = path.join(stagedDir, file)
      const target = path.join(pluginDir, file)
      const saved = path.join(backupDir, "files", file)
      const existed = fs.existsSync(target)
      if (existed) {
        fs.mkdirSync(path.dirname(saved), { recursive: true })
        fs.copyFileSync(target, saved)
      }
      if (fs.existsSync(source)) {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        const temporary = `${target}.guard-update`
        fs.copyFileSync(source, temporary)
        fs.renameSync(temporary, target)
      } else if (existed) fs.rmSync(target, { force: true })
      undo.push(() => {
        if (existed) fs.copyFileSync(saved, target)
        else fs.rmSync(target, { force: true })
      })
    }
  } catch (error) {
    rollback()
    throw new Error(M.update.swapFailed((error as Error).message))
  }
  return { rollback }
}
