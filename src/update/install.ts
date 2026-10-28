import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { M } from "../shared/messages.js"
import { requestHeaders, type ReleaseInfo } from "./release.js"

const maxArchiveBytes = 256 * 1024 * 1024
const maxChecksumBytes = 64 * 1024
const downloadTimeoutMs = 10 * 60 * 1000
const extractTimeoutMs = 2 * 60 * 1000
const packageName = "yunzai-guard"
const managedItems = [
  "index.js",
  "dist",
  "native",
  "examples",
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "SECURITY.md",
  "settings.example.json",
  "settings.plugin-sandbox.example.json",
]

export interface StagedRelease {
  version: string
  /** 已解压并校验的包目录。 */
  directory: string
}

export interface SwapHandle {
  /** 还原到替换前的文件。 */
  rollback(): void
  /** 放弃回退能力，清理暂存文件；上一版本保留在 previous 目录。 */
  commit(): void
}

/** 返回当前平台的发布包名；不支持的平台返回 undefined。 */
export function assetName(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  if (platform === "darwin") return `yunzai-guard-v${version}-macos.tar.gz`
  if (arch !== "x64") return undefined
  if (platform === "win32") return `yunzai-guard-v${version}-win-x64.zip`
  if (platform === "linux") return `yunzai-guard-v${version}-linux-x64.tar.gz`
  return undefined
}

/** 解析 SHA256SUMS.txt 中指定文件的摘要。 */
export function checksumFor(text: string, name: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/i.exec(line.trim())
    if (match && match[2] === name) return match[1]!.toLowerCase()
  }
  return undefined
}

/** 取得更新工作目录，并保证其位于插件目录内以便原子重命名。 */
export function workPaths(pluginDir: string): {
  base: string
  download: string
  staged: string
  previous: string
} {
  const base = path.join(pluginDir, ".update")
  return {
    base,
    download: path.join(base, "download"),
    staged: path.join(base, "staged"),
    previous: path.join(base, "previous"),
  }
}

/** 下载文件并边写边计算 SHA-256，超过上限立即中止。 */
async function download(
  url: string,
  file: string,
  version: string,
  limit: number,
): Promise<string> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: requestHeaders(version),
      signal: AbortSignal.timeout(downloadTimeoutMs),
    })
  } catch (error) {
    throw new Error(M.update.downloadFailed((error as Error).message))
  }
  if (!response.ok || !response.body)
    throw new Error(M.update.downloadFailed(`HTTP ${response.status}`))
  const hash = createHash("sha256")
  let received = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length
      if (received > limit) return callback(new Error(M.update.tooLarge))
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  try {
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      meter,
      fs.createWriteStream(file, { mode: 0o600 }),
    )
  } catch (error) {
    fs.rmSync(file, { force: true })
    throw new Error(M.update.downloadFailed((error as Error).message))
  }
  return hash.digest("hex")
}

/** 调用系统 tar 解压；Windows 使用系统目录下的 bsdtar，避免依赖 PATH。 */
function extract(archive: string, destination: string): Promise<void> {
  const executable =
    process.platform === "win32"
      ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : "tar"
  const flags = archive.endsWith(".zip") ? "-xf" : "-xzf"
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [flags, archive, "-C", destination], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      timeout: extractTimeoutMs,
    })
    let stderr = ""
    child.stderr.on("data", chunk => {
      if (stderr.length < 2000) stderr += chunk
    })
    child.once("error", error => reject(new Error(M.update.extractFailed(error.message))))
    child.once("close", code =>
      code === 0
        ? resolve()
        : reject(new Error(M.update.extractFailed(stderr.trim() || `退出码 ${code}`))),
    )
  })
}

/** 确认解压结果中没有指向目录外的链接。 */
function assertContained(directory: string): void {
  const base = fs.realpathSync(directory)
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(file)
        if (target !== base && !target.startsWith(base + path.sep))
          throw new Error(M.update.packageInvalid(entry.name))
      } else if (entry.isDirectory()) walk(file)
    }
  }
  walk(base)
}

/** 校验包目录就是请求的版本，并带有运行入口。 */
function assertPackage(directory: string, version: string): void {
  let manifest: { name?: unknown; version?: unknown }
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"))
  } catch {
    throw new Error(M.update.packageInvalid("package.json"))
  }
  if (manifest.name !== packageName || manifest.version !== version)
    throw new Error(M.update.packageInvalid("package.json"))
  for (const required of ["index.js", "dist/launcher.js", "dist/entry/plugin.js", "dist/cli.js"])
    if (!fs.existsSync(path.join(directory, required)))
      throw new Error(M.update.packageInvalid(required))
}

/** 下载、校验并解压发布包到暂存目录；不触碰正在运行的文件。 */
export async function stageRelease(
  release: ReleaseInfo,
  pluginDir: string,
  currentVersion: string,
): Promise<StagedRelease> {
  const name = assetName(release.version)
  if (!name) throw new Error(M.update.unsupportedPlatform)
  const archive = release.assets.find(item => item.name === name)
  const sums = release.assets.find(item => item.name === "SHA256SUMS.txt")
  if (!archive) throw new Error(M.update.noAsset(name))
  if (!sums) throw new Error(M.update.noAsset("SHA256SUMS.txt"))
  const paths = workPaths(pluginDir)
  clearWork(pluginDir)
  fs.mkdirSync(paths.download, { recursive: true })
  fs.mkdirSync(paths.staged, { recursive: true })
  const sumsFile = path.join(paths.download, "SHA256SUMS.txt")
  await download(sums.url, sumsFile, currentVersion, maxChecksumBytes)
  const expected = checksumFor(fs.readFileSync(sumsFile, "utf8"), name)
  if (!expected) throw new Error(M.update.noChecksum(name))
  const file = path.join(paths.download, name)
  const actual = await download(archive.url, file, currentVersion, maxArchiveBytes)
  if (actual !== expected) throw new Error(M.update.checksumMismatch)
  await extract(file, paths.staged)
  const directory = path.join(paths.staged, packageName)
  assertContained(paths.staged)
  assertPackage(directory, release.version)
  return { version: release.version, directory }
}

/** 重命名，必要时创建目标的父目录。 */
function move(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.renameSync(from, to)
}

/** 用暂存包替换插件文件；任何一步失败都还原已完成的步骤。 */
export function swapPackage(staged: StagedRelease, pluginDir: string): SwapHandle {
  const paths = workPaths(pluginDir)
  fs.rmSync(paths.previous, { recursive: true, force: true })
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
  try {
    for (const name of managedItems) {
      const next = path.join(staged.directory, name)
      if (!fs.existsSync(next)) continue
      const current = path.join(pluginDir, name)
      const saved = path.join(paths.previous, name)
      const existed = fs.existsSync(current)
      if (existed) {
        move(current, saved)
        undo.push(() => {
          fs.rmSync(current, { recursive: true, force: true })
          fs.renameSync(saved, current)
        })
      }
      move(next, current)
      if (!existed) undo.push(() => fs.rmSync(current, { recursive: true, force: true }))
    }
    const bundled = path.join(staged.directory, "runtime")
    if (fs.existsSync(bundled))
      for (const entry of fs.readdirSync(bundled)) {
        const target = path.join(pluginDir, "runtime", entry)
        if (fs.existsSync(target)) continue
        move(path.join(bundled, entry), target)
        undo.push(() => fs.rmSync(target, { recursive: true, force: true }))
      }
  } catch (error) {
    rollback()
    throw new Error(M.update.swapFailed((error as Error).message))
  }
  return {
    rollback,
    /** 暂存与下载文件不再需要，上一版本保留供手动回退。 */
    commit() {
      fs.rmSync(paths.staged, { recursive: true, force: true })
      fs.rmSync(paths.download, { recursive: true, force: true })
    },
  }
}

/** 清理更新工作目录。 */
export function clearWork(pluginDir: string): void {
  const paths = workPaths(pluginDir)
  fs.rmSync(paths.staged, { recursive: true, force: true })
  fs.rmSync(paths.download, { recursive: true, force: true })
}
