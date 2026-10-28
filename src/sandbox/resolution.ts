import fs from "node:fs"
import path from "node:path"
import { registerHooks } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { within } from "../protect/paths.js"
import { M } from "../shared/messages.js"

export interface ModuleAliases {
  root: string
  links: Array<{ from: string; to: string }>
  /** 不重写指向当前会话可写授权范围的普通 pnpm 工作区反向链接。 */
  skippedWritableBacklinks?: Array<{ from: string; to: string }>
  /** 核心根包的反向链接由 guest 包映射接管，不加入路径重写表或授予目标写权限。 */
  skippedCoreBacklinks?: Array<{ from: string; to: string }>
}

const maxManifestBytes = 8 * 1024 * 1024
const maxAliasBytes = 6 * 1024 * 1024
const maxAliases = 8192
const maxScanEntries = 250000
const defaults = ["data", "temp", "logs", "config/config", ".git", ".cache"]
/** Windows 下统一为小写以便比较路径。 */
const fold = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value)
/** 把相对路径转为正斜杠形式。 */
const relativeName = (value: string): string => value.split(path.sep).join("/")

/** 判断相对路径是否位于排除目录中。 */
function excluded(relative: string, directories: readonly string[]): boolean {
  const candidate = fold(relativeName(relative))
  return (
    candidate.split("/").some(part => part === ".git" || part === ".cache") ||
    directories.some(
      directory => candidate === fold(directory) || candidate.startsWith(`${fold(directory)}/`),
    )
  )
}

/** 仅由宿主生成快照；链接不授予系统访问权，此处不遍历链接目标。 */
export function collectWindowsAliases(
  projectRoot: string,
  writablePaths: readonly string[] = [],
  writableFiles: readonly string[] = [],
): ModuleAliases {
  const root = fs.realpathSync.native(projectRoot)
  const writeDirectories = writablePaths.map(relativeName)
  const writeFiles = writableFiles.map(relativeName)
  if ([...writeDirectories, ...writeFiles].some(value => !validRelative(value)))
    throw new Error(M.sandbox.aliasWritable)
  const ignored = [...defaults, ...writeDirectories, ...writeFiles]
  const links: ModuleAliases["links"] = []
  const skippedWritableBacklinks: ModuleAliases["links"] = []
  const skippedCoreBacklinks: ModuleAliases["links"] = []
  let jiuli = false
  try {
    const file = path.join(root, "package.json")
    const metadata = fs.lstatSync(file)
    if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 256 * 1024)
      jiuli = JSON.parse(fs.readFileSync(file, "utf8"))?.name === "jiuli"
  } catch {
    // 无法确认自身包身份时不放宽链接检查。
  }
  const pending = [{ directory: root, dependency: false }]
  for (const relative of writeDirectories) {
    const parts = relative.split("/")
    if (parts.length !== 2 || fold(parts[0]) !== "plugins") continue
    const pluginRoot = path.join(root, relative)
    const pluginStat = fs.lstatSync(pluginRoot, { throwIfNoEntry: false })
    if (!pluginStat) continue
    if (
      !pluginStat.isDirectory() ||
      pluginStat.isSymbolicLink() ||
      fold(fs.realpathSync.native(pluginRoot)) !== fold(pluginRoot)
    )
      throw new Error(M.sandbox.aliasSource)
    const directory = path.join(pluginRoot, "node_modules")
    if (fs.lstatSync(directory, { throwIfNoEntry: false }))
      pending.push({ directory, dependency: true })
  }
  const seen = new Set<string>()
  const contains = (parent: string, child: string) =>
    fold(parent) === fold(child) || fold(child).startsWith(`${fold(parent)}/`)
  const overlaps = (a: string, b: string) =>
    a === "." || b === "." || contains(a, b) || contains(b, a)
  let entries = 0
  let bytes = Buffer.byteLength(JSON.stringify({ root, links: [] }))
  const addAlias = (filename: string, dependency: boolean) => {
    const from = relativeName(path.relative(root, filename))
    const canonical = fs.realpathSync.native(filename)
    if (!within(root, canonical)) throw new Error(M.sandbox.aliasEscape(from))
    const to = relativeName(path.relative(root, canonical)) || "."
    const coreBacklink =
      jiuli &&
      to === "." &&
      (fold(from) === "node_modules/jiuli" ||
        fold(from) === "node_modules/.pnpm/node_modules/jiuli" ||
        /^plugins\/(?!yunzai-guard\/)[^/]+\/node_modules\/jiuli$/.test(fold(from)))
    if (!coreBacklink && (excluded(to, defaults) || defaults.some(value => overlaps(to, value))))
      throw new Error(M.sandbox.aliasProtected(from))
    const writable = [...writeDirectories, ...writeFiles].some(value => overlaps(to, value))
    if (!coreBacklink && writable && dependency) throw new Error(M.sandbox.aliasToWritable(from))
    if (!validRelative(from) || !validRelative(to, true)) throw new Error(M.sandbox.aliasPath)
    if (seen.has(fold(from))) return
    if (links.length + skippedWritableBacklinks.length + skippedCoreBacklinks.length >= maxAliases)
      throw new Error(M.sandbox.aliasLimit)
    const link = { from, to }
    bytes += Buffer.byteLength(JSON.stringify(link)) + 1
    if (bytes > maxAliasBytes) throw new Error(M.sandbox.aliasMapSize)
    seen.add(fold(from))
    // 只读全局虚拟库通常包含指回工作区包的链接。
    // 这些可变目标不能加入可信的规范路径解析表。
    if (coreBacklink) skippedCoreBacklinks.push(link)
    else if (writable) skippedWritableBacklinks.push(link)
    else links.push(link)
  }
  while (pending.length) {
    const { directory, dependency } = pending.pop()!
    const stat = fs.lstatSync(directory)
    if (stat.isSymbolicLink()) {
      if (!dependency) throw new Error(M.sandbox.aliasDirChanged(directory))
      addAlias(directory, true)
      continue
    }
    if (!stat.isDirectory()) throw new Error(M.sandbox.aliasNotDir(directory))
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (++entries > maxScanEntries) throw new Error(M.sandbox.aliasScanLimit)
      const filename = path.join(directory, entry.name)
      const from = relativeName(path.relative(root, filename))
      if (excluded(from, dependency ? defaults : ignored)) continue
      if (entry.isSymbolicLink()) addAlias(filename, dependency)
      else if (entry.isDirectory()) pending.push({ directory: filename, dependency })
    }
  }
  links.sort((a, b) => b.from.length - a.from.length || a.from.localeCompare(b.from))
  skippedWritableBacklinks.sort(
    (a, b) => b.from.length - a.from.length || a.from.localeCompare(b.from),
  )
  skippedCoreBacklinks.sort((a, b) => b.from.length - a.from.length || a.from.localeCompare(b.from))
  const result: ModuleAliases = { root, links }
  if (skippedWritableBacklinks.length) result.skippedWritableBacklinks = skippedWritableBacklinks
  if (skippedCoreBacklinks.length) result.skippedCoreBacklinks = skippedCoreBacklinks
  if (Buffer.byteLength(JSON.stringify(result)) > maxAliasBytes)
    throw new Error(M.sandbox.aliasMapSize)
  return result
}

/** 校验别名表中的相对路径。 */
function validRelative(value: unknown, allowRoot = false): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    ((allowRoot && value === ".") ||
      (!/[\\:\x00-\x1f]/.test(value) &&
        !path.isAbsolute(value) &&
        value.split("/").every(part => part.length > 0 && part !== "." && part !== "..")))
  )
}

/** 解析并校验模块别名表。 */
function parseAliases(value: unknown): ModuleAliases {
  const input = value as Partial<ModuleAliases> | null
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.root !== "string" ||
    !path.isAbsolute(input.root) ||
    !Array.isArray(input.links) ||
    input.links.length > maxAliases
  )
    throw new Error(M.sandbox.aliasMap)
  if (Buffer.byteLength(JSON.stringify(input)) > maxAliasBytes)
    throw new Error(M.sandbox.aliasMapSize)
  const seen = new Set<string>()
  const links = input.links.map(link => {
    if (!link || !validRelative(link.from) || !validRelative(link.to, true))
      throw new Error(M.sandbox.aliasPath)
    const key = fold(link.from)
    if (seen.has(key)) throw new Error(M.sandbox.aliasDuplicate)
    seen.add(key)
    return { from: link.from, to: link.to }
  })
  links.sort((a, b) => b.from.length - a.from.length || a.from.localeCompare(b.from))
  return { root: path.resolve(input.root), links }
}

const installed = new Map<string, () => void>()

/** 恢复模块规范位置，并用 preserve-symlinks 避免查询无权访问的祖先路径。 */
export function installSandboxResolution(manifestPath?: string): () => void {
  if (!manifestPath) return () => {}
  const filename = path.resolve(manifestPath)
  const prior = installed.get(filename)
  if (prior) return prior
  const bytes = fs.readFileSync(filename)
  if (bytes.length > maxManifestBytes) throw new Error(M.sandbox.manifestTooLarge)
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
    moduleAliases?: unknown
  }
  if (manifest.moduleAliases === undefined) return () => {}
  const aliases = parseAliases(manifest.moduleAliases)
  const root = aliases.root
  const hooks = registerHooks({
    /** 把解析到沙箱外部的模块路径改写为受信别名。 */
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context)
      if (!result.url.startsWith("file:")) return result
      const url = new URL(result.url)
      let location = fileURLToPath(url)
      if (!within(root, location)) return result
      const visited = new Set<string>()
      for (let depth = 0; depth < 32; depth++) {
        const relative = relativeName(path.relative(root, location))
        const key = fold(relative)
        const alias = aliases.links.find(
          link => key === fold(link.from) || key.startsWith(`${fold(link.from)}/`),
        )
        if (!alias) {
          if (!visited.size) return result
          const canonical = pathToFileURL(location)
          canonical.search = url.search
          canonical.hash = url.hash
          return { ...result, url: canonical.href }
        }
        if (visited.has(key)) throw new Error(M.sandbox.aliasCycle)
        visited.add(key)
        const tail = relative.slice(alias.from.length).replace(/^\//, "")
        location = path.resolve(root, alias.to, tail)
        if (!within(root, location)) throw new Error(M.sandbox.aliasEscaped)
      }
      throw new Error(M.sandbox.aliasChain)
    },
  })
  const dispose = () => {
    hooks.deregister()
    installed.delete(filename)
  }
  installed.set(filename, dispose)
  return dispose
}
