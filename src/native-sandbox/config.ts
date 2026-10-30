import { action, boolean, keys, number, object, string } from "../config/validation.js"
import type { NativeSandboxPlugin, NativeSandboxSettings, NativeRedisPermissions } from "./types.js"
import { M } from "../shared/messages.js"

/** 核心目录与 Guard 自身，不能作为原生沙盒对象；控制台据此标记，避免给出会被拒绝的入口。 */
export const reservedDirectories: ReadonlySet<string> = new Set([
  "yunzai-guard",
  "adapter",
  "system",
  "other",
  "example",
])
export const nativeRedisReservedPrefixes: readonly string[] = Object.freeze([
  "yunzai-guard:",
  "yunzaiguard:",
])

/** Redis 授权使用区分大小写的字面键名或前缀，不接受通用 glob 或正则。 */
export function parseNativeRedisPermissions(
  value?: unknown,
  location = "native.redis",
): NativeRedisPermissions {
  const source = object(value === undefined ? {} : value, location)
  keys(source, ["read", "write"], location)
  const grants = (kind: "read" | "write"): string[] => {
    const input = source[kind] === undefined ? [] : source[kind]
    if (!Array.isArray(input) || input.length > 32)
      throw new TypeError(M.nativeSandbox.redisGrantLimit(location, kind))
    const result: string[] = []
    for (let index = 0; index < input.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
      if (!descriptor || !Object.hasOwn(descriptor, "value"))
        throw new TypeError(M.nativeSandbox.redisGrantElements(location, kind))
      const pattern = string(descriptor.value, `${location}.${kind}[${index}]`, 256)
      const wildcard = pattern.endsWith("*")
      const prefix = wildcard ? pattern.slice(0, -1) : pattern
      if (
        !prefix ||
        pattern.trim() !== pattern ||
        /[\x00-\x1f\x7f?\[\]\\]/.test(pattern) ||
        prefix.includes("*")
      )
        throw new TypeError(M.nativeSandbox.redisGrantPattern(location, kind, index))
      const folded = prefix.toLowerCase()
      if (
        nativeRedisReservedPrefixes.some(
          reserved => folded.startsWith(reserved) || (wildcard && reserved.startsWith(folded)),
        )
      )
        throw new TypeError(M.nativeSandbox.redisGrantGuard(location, kind, index))
      if (result.includes(pattern))
        throw new TypeError(M.nativeSandbox.redisGrantDuplicate(location, kind))
      result.push(pattern)
    }
    Object.freeze(result)
    return result
  }
  return Object.freeze({ read: grants("read"), write: grants("write") })
}
// 包含当前 TRSS 默认配置及旧账号配置名；启动器补充实际默认名称。
export const protectedNativeCoreConfigFiles: readonly string[] = Object.freeze([
  "bot.yaml",
  "db.yaml",
  "group.yaml",
  "milky.yaml",
  "other.yaml",
  "redis.yaml",
  "renderer.yaml",
  "satori.yaml",
  "server.yaml",
  "qq.yaml",
])

/** 判断两个路径是否互相包含。 */
const overlaps = (left: string, right: string) => {
  const a = left.toLowerCase(),
    b = right.toLowerCase()
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

/** 解析可写授权并检查互不重叠。 */
function writableGrants(
  value: unknown,
  kind: "directory" | "file",
  location: string,
  protectedCoreFiles: readonly string[] = [],
): string[] {
  const input = value === undefined ? [] : value
  if (!Array.isArray(input) || input.length > 16)
    throw new TypeError(M.nativeSandbox.pathLimit(location))
  if (protectedCoreFiles.some(name => typeof name !== "string" || /[\\/]/.test(name)))
    throw new TypeError(M.nativeSandbox.coreConfigName)
  const protectedNames = new Set(
    [...protectedNativeCoreConfigFiles, ...protectedCoreFiles].map(name => name.toLowerCase()),
  )
  const result: string[] = []
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, "value"))
      throw new TypeError(M.nativeSandbox.pathElements(location))
    const target = string(descriptor.value, `${location}[${index}]`, 256)
    const parts = target.split("/")
    if (
      parts.length < 2 ||
      !["data", "config", "temp"].includes(parts[0].toLowerCase()) ||
      parts.some(
        part =>
          !part ||
          part === "." ||
          part === ".." ||
          part.trim() !== part ||
          part.endsWith(".") ||
          /[<>:"\\|?*\[\]{}$();`\u0000-\u001f\u007f]/.test(part) ||
          /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part),
      )
    )
      throw new TypeError(M.nativeSandbox.pathScope(location, index))
    const folded = target.toLowerCase()
    if (overlaps(folded, "data/yunzai-guard") || overlaps(folded, "config/default_config"))
      throw new TypeError(M.nativeSandbox.pathGuard(location, index))
    if (kind === "directory" && overlaps(folded, "config/config"))
      throw new TypeError(M.nativeSandbox.pathCoreTree(location, index))
    if (kind === "file" && folded === "config/config")
      throw new TypeError(M.nativeSandbox.pathCoreFile(location, index))
    if (
      [...protectedNames].some(
        name => overlaps(folded, `config/${name}`) || overlaps(folded, `config/config/${name}`),
      )
    )
      throw new TypeError(M.nativeSandbox.pathProtected(location, index))
    if (result.some(previous => overlaps(previous, target)))
      throw new TypeError(M.nativeSandbox.pathOverlap(location))
    result.push(target)
  }
  Object.freeze(result)
  return result
}

/** 校验原生沙箱的可写目录。 */
export function validateNativeWritablePaths(
  value?: unknown,
  location = "native.writablePaths",
): string[] {
  return writableGrants(value, "directory", location)
}

/** protectedCoreFiles 为 config/default_config 中的文件名，不是项目相对路径。 */
export function validateNativeWritableFiles(
  value?: unknown,
  location = "native.writableFiles",
  protectedCoreFiles: readonly string[] = [],
): string[] {
  return writableGrants(value, "file", location, protectedCoreFiles)
}

/** 校验原生沙箱的可写文件授权。 */
export function validateNativeWriteGrants(
  paths?: unknown,
  files?: unknown,
  location = "native",
  protectedCoreFiles: readonly string[] = [],
): { writablePaths: string[]; writableFiles: string[] } {
  const writablePaths = validateNativeWritablePaths(paths, `${location}.writablePaths`)
  const writableFiles = validateNativeWritableFiles(
    files,
    `${location}.writableFiles`,
    protectedCoreFiles,
  )
  if (writablePaths.length + writableFiles.length > 16)
    throw new TypeError(M.nativeSandbox.writeGrantLimit(location))
  if (writablePaths.some(directory => writableFiles.some(file => overlaps(directory, file))))
    throw new TypeError(M.nativeSandbox.writeGrantOverlap(location))
  return Object.freeze({ writablePaths, writableFiles })
}

/** 独立解析，避免其他沙箱模式扩大原生插件权限。 */
export function parseNativeSandbox(value?: unknown): NativeSandboxSettings {
  const location = "settings.pluginSandbox.native"
  const source = object(value === undefined ? {} : value, location)
  keys(source, ["plugins"], location)
  const input = source.plugins === undefined ? [] : source.plugins
  if (!Array.isArray(input) || input.length > 128)
    throw new TypeError(M.nativeSandbox.pluginsLimit(location))
  const identities = new Set<string>()
  const scopes: { id: string; target: string; kind: "directory" | "file" }[] = []
  const plugins = input.map((item, index): NativeSandboxPlugin => {
    const at = `${location}.plugins[${index}]`
    const entry = object(item, at)
    keys(
      entry,
      [
        "id",
        "enabled",
        "timeoutMs",
        "network",
        "hookAction",
        "adapters",
        "allowCoreRestart",
        "writablePaths",
        "writableFiles",
        "redis",
      ],
      at,
    )
    const id = string(entry.id, `${at}.id`, 128)
    const identity = id.toLowerCase()
    if (
      !/^[A-Za-z0-9_-]+$/.test(id) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(id) ||
      reservedDirectories.has(identity)
    )
      throw new TypeError(M.nativeSandbox.pluginId(at))
    if (identities.has(identity)) throw new TypeError(M.nativeSandbox.pluginsDuplicate(location))
    identities.add(identity)
    const network = entry.network === undefined ? "none" : entry.network
    if (network !== "none" && network !== "host") throw new TypeError(M.nativeSandbox.network(at))
    const grants = validateNativeWriteGrants(entry.writablePaths, entry.writableFiles, at)
    const enabled = boolean(entry.enabled, true, `${at}.enabled`)
    if (enabled)
      for (const kind of ["directory", "file"] as const)
        for (const target of kind === "directory" ? grants.writablePaths : grants.writableFiles) {
          const collision = scopes.find(scope => overlaps(scope.target, target))
          // 共享要求每个启用的参与者显式授权同一原目录；
          // 父目录、文件或大小写别名不能继承该权限。
          if (
            collision &&
            !(kind === "directory" && collision.kind === kind && collision.target === target)
          )
            throw new TypeError(M.nativeSandbox.writeCollision(at, collision.id))
          scopes.push({ id, target, kind })
        }
    return Object.freeze({
      id,
      enabled,
      timeoutMs: number(entry.timeoutMs, 10000, `${at}.timeoutMs`, 100, 60000),
      network,
      hookAction: action(entry.hookAction, "deny", `${at}.hookAction`),
      adapters: boolean(entry.adapters, false, `${at}.adapters`),
      allowCoreRestart: boolean(entry.allowCoreRestart, false, `${at}.allowCoreRestart`),
      redis: parseNativeRedisPermissions(entry.redis, `${at}.redis`),
      ...grants,
    })
  })
  Object.freeze(plugins)
  return Object.freeze({ plugins })
}

/** 仅用于内部启动元数据，不增加原路径授权之外的权限。 */
export function nativeSharedWritablePaths(settings: NativeSandboxSettings, id: string): string[] {
  const config = settings.plugins.find(plugin => plugin.id === id && plugin.enabled)
  if (!config) return []
  return config.writablePaths.filter(target =>
    settings.plugins.some(
      plugin => plugin !== config && plugin.enabled && plugin.writablePaths.includes(target),
    ),
  )
}
