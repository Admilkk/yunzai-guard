import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { timingSafeEqual } from "node:crypto"
import { types } from "node:util"
import * as inspector from "node:inspector"
import { isSupportedPm2Version } from "./versions.js"
import { ownData } from "./legacy-sidecar.js"
import type { Pm2ApplicationOptions, Pm2DaemonGod, Pm2DaemonContext } from "./types.js"
import type { Pm2LoggingUtility } from "./log-stream-gate-v1.js"
import { M } from "../shared/messages.js"

/** 返回规范化的真实路径。 */
export function canonical(file: string): string {
  const value = path.normalize(fs.realpathSync.native(file))
  return process.platform === "win32" ? value.toLowerCase() : value
}
/** 判断为非 Proxy 的普通对象。 */
export function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value))
    return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
/** 判断整数是否在范围内。 */
export function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
}
/** 确认对象指定属性可写。 */
export function writable(object: object, keys: string[]): void {
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    if (descriptor) {
      if (!("value" in descriptor) || !descriptor.writable) throw new Error(M.pm2.appDescriptors)
    } else if (!Object.isExtensible(object)) throw new Error(M.pm2.appFrozen)
  }
}
/** 判断随机串是否匹配。 */
export function sameNonce(value: unknown, nonce: string): boolean {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) === Buffer.byteLength(nonce) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(nonce))
  )
}

/** 查找运行中守护进程的单例，不执行任何 God 模块。 */
export function resolveCachedGod(
  cache: Readonly<Record<string, { loaded?: boolean; exports: unknown } | undefined>>,
  physicalGodPath: string,
): Pm2DaemonGod {
  const expected = canonical(physicalGodPath)
  const matches: ({ loaded?: boolean; exports: unknown } | undefined)[] = []
  for (const [filename, entry] of Object.entries(cache)) {
    if (!path.isAbsolute(filename)) continue
    try {
      if (canonical(filename) === expected) matches.push(entry)
    } catch {
      // 无关的过期缓存路径不构成加载新代码的授权。
    }
  }
  if (matches.length !== 1 || matches[0]?.loaded !== true) throw new Error(M.pm2.godModule)
  const god = matches[0].exports as Pm2DaemonGod | undefined
  if (
    !god ||
    typeof god !== "object" ||
    !ownData(god, "clusters_db") ||
    typeof ownData(god, "clusters_db") !== "object" ||
    Array.isArray(god.clusters_db) ||
    typeof ownData(god, "processIsDead") !== "function" ||
    typeof ownData(god, "handleExit") !== "function" ||
    typeof ownData(god, "forkMode") !== "function" ||
    typeof ownData(god, "restartProcessId") !== "function"
  )
    throw new Error(M.pm2.godCached)
  return god
}

/** 取得并校验当前 PM2 daemon 的 God 对象。 */
export function currentDaemonGod(
  options: Pick<Pm2ApplicationOptions, "expectedDaemonPid" | "pm2Root">,
): Pm2DaemonGod {
  if (
    !integer(options.expectedDaemonPid, 2, 2147483647) ||
    options.expectedDaemonPid !== process.pid ||
    typeof options.pm2Root !== "string" ||
    !path.isAbsolute(options.pm2Root)
  )
    throw new Error(M.pm2.daemonMismatch)
  if (!["win32", "linux"].includes(process.platform)) throw new Error(M.pm2.platform)
  // 加载器及文件路径保留磁盘原始大小写。Windows 上将 require 路径
  // 统一大小写可能执行第二份 CJS God 模块，得到空数据库。
  const pm2Root = fs.realpathSync.native(options.pm2Root)
  const main = fs.realpathSync.native(process.argv[1] ?? "")
  if (canonical(main) !== canonical(path.join(pm2Root, "lib", "Daemon.js")))
    throw new Error(M.pm2.wrongDaemon)
  const metadata: unknown = JSON.parse(fs.readFileSync(path.join(pm2Root, "package.json"), "utf8"))
  if (!plain(metadata) || metadata.name !== "pm2" || !isSupportedPm2Version(metadata.version))
    throw new Error(M.pm2.version)
  const require = createRequire(main)
  return resolveCachedGod(
    require.cache,
    fs.realpathSync.native(path.join(pm2Root, "lib", "God.js")),
  )
}

/** 解析 PM2 ForkMode 已捕获的同一个 Utility 单例。 */
export function resolveCachedLoggingUtility(pm2Root: string): Pm2LoggingUtility | undefined {
  let expected: string
  try {
    expected = canonical(path.join(pm2Root, "lib", "Utility.js"))
  } catch {
    return undefined
  }
  const require = createRequire(process.argv[1])
  const matches = Object.entries(require.cache).filter(([filename]) => {
    try {
      return canonical(filename) === expected
    } catch {
      return false
    }
  })
  if (matches.length !== 1 || matches[0][1]?.loaded !== true) return undefined
  const utility = matches[0][1].exports as Pm2LoggingUtility
  try {
    return utility &&
      typeof utility === "object" &&
      typeof ownData(utility, "startLogging") === "function"
      ? utility
      : undefined
  } catch {
    return undefined
  }
}

/** 返回 daemon 运行上下文。 */
export function runtimeContext(pm2Root?: string): Pm2DaemonContext {
  return {
    daemonPid: process.pid,
    ...(pm2Root ? { loggingUtility: resolveCachedLoggingUtility(pm2Root) } : {}),
    report: event => console.error(`${M.pm2.preloadTag} ${JSON.stringify(event)}`),
    inspector: { url: inspector.url, close: inspector.close },
  }
}
