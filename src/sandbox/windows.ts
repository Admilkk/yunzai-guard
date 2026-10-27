import fs from "node:fs"
import os from "node:os"
import nodePath from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { collectWindowsAliases } from "./resolution.js"
import { prependWindowsRuntimePath } from "./windows-runtime.js"
import { windowsBroker } from "../dependencies/windows-broker.js"
import { verifyFile } from "../dependencies/files.js"
import {
  validateNativeWritableFiles,
  validateNativeWritablePaths,
} from "../native-sandbox/config.js"

import {
  addCounter,
  createCanonicalObserver,
  createTransportCounters,
  type CanonicalStats,
  type TransportCounters,
} from "./windows/diagnostics.js"
import { writeControl, forwardOutput, disposeProcess } from "./windows/transport.js"
import { within } from "../protect/paths.js"
import { M } from "../shared/messages.js"

const path = Object.freeze({ ...nodePath })
const createDirectory = fs.mkdirSync.bind(fs)
const createTemporary = fs.mkdtempSync.bind(fs)
const openFile = fs.openSync.bind(fs)
const writeFile = fs.writeSync.bind(fs)
const closeFile = fs.closeSync.bind(fs)
const truncateFile = fs.ftruncateSync.bind(fs)
const fileStat = fs.fstatSync.bind(fs)
const changeMode = fs.chmodSync.bind(fs)
const removeFile = fs.unlinkSync.bind(fs)
const readFile = fs.readFileSync.bind(fs)
const entryStat = fs.lstatSync.bind(fs)
const exists = fs.existsSync.bind(fs)
const realpath = fs.realpathSync.native.bind(fs)
const isFile = Function.prototype.call.bind(fs.Stats.prototype.isFile) as (
  stat: fs.Stats,
) => boolean
const isDirectory = Function.prototype.call.bind(fs.Stats.prototype.isDirectory) as (
  stat: fs.Stats,
) => boolean
const isSymbolicLink = Function.prototype.call.bind(fs.Stats.prototype.isSymbolicLink) as (
  stat: fs.Stats,
) => boolean
const temporaryRoot = (() => {
  try {
    return realpath(os.tmpdir())
  } catch {
    return path.resolve(os.tmpdir())
  }
})()
const bytes = Buffer.from.bind(Buffer)
const parse = JSON.parse.bind(JSON)
const stringify = JSON.stringify.bind(JSON)
const runtimeKey = Symbol.for("yunzai.guard.runtime.v1")
const initialRoot = (() => {
  try {
    return realpath(process.cwd())
  } catch {
    return path.resolve(process.cwd())
  }
})()
const guardRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)))
const ownDescriptor = Object.getOwnPropertyDescriptor.bind(Object)
const lower = Function.prototype.call.bind(String.prototype.toLowerCase) as (
  value: string,
) => string
const regexpExec = Function.prototype.call.bind(RegExp.prototype.exec) as (
  pattern: RegExp,
  value: string,
) => RegExpExecArray | null

/** 写入私有文件，可选在身份未变时替换。 */
function writeOwned(file: string, value: string | Uint8Array, mode = 0o600, replace = false): void {
  const before = replace ? entryStat(file) : undefined
  const fd = openFile(file, replace ? "r+" : "wx", mode)
  try {
    if (before) {
      const current = fileStat(fd)
      if (
        !isFile(current) ||
        current.nlink !== 1 ||
        current.dev !== before.dev ||
        current.ino !== before.ino
      )
        throw new Error(M.sandbox.ownerRecord)
      truncateFile(fd, 0)
    }
    const content = typeof value === "string" ? bytes(value) : value
    let offset = 0
    while (offset < content.length) {
      const written = writeFile(fd, content, offset, content.length - offset, offset)
      if (!written) throw Object.assign(new Error("EIO"), { code: "EIO" })
      offset += written
    }
  } finally {
    closeFile(fd)
  }
}

/** 删除 Guard 自己创建的文件。 */
function removeOwned(file: string): void {
  try {
    removeFile(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}
export {
  createCanonicalObserver as createWindowsCanonicalObserver,
  createTransportCounters as createWindowsSandboxTransportCounters,
  type CanonicalSnapshot as WindowsCanonicalSnapshot,
  type CanonicalStats as WindowsCanonicalStats,
  type TransportCounters as WindowsSandboxTransportCounters,
} from "./windows/diagnostics.js"
export {
  writeControl as writeWindowsSandboxControl,
  forwardOutput as forwardWindowsSandboxOutput,
  disposeProcess as disposeWindowsSandboxProcess,
} from "./windows/transport.js"

export interface WindowsSandboxSettings {
  shutdownTimeout?: number
  sandbox?: { network: "none" | "host"; writablePaths?: string[]; writableFiles?: string[] }
}

export interface WindowsSandboxLaunch {
  executable: string
  args: string[]
  env: NodeJS.ProcessEnv
  runtimeManifest?: string
  cwd?: string
  forwardOutput?: boolean
  /** 插件会话独立的归属日志；省略时沿用项目单实例日志。 */
  sessionKey?: string
  /** 协调原 data/config/temp 精确目录授权的内部元数据。 */
  sharedWritablePaths?: string[]
  /** 已接受的来源摘要，复制到会话后须再次核验。 */
  expectedExecutableSha256?: string
  /** 按名称启动 node 子进程时仅使用当前会话运行时。 */
  prependRuntimePath?: boolean
  /** 需从可读项目树中隐藏的可信宿主目录。 */
  additionalDeniedPaths?: string[]
  /** 可信的已验证运行时能力，或显式自编原生验证。 */
  canonicalMetadataProtocol?: 1
}

export interface WindowsSandboxProcess extends ChildProcess {
  sandboxPid?: number
  sandboxClientId?: number
  sandboxSession: string
  sandboxCleanup: Promise<void>
  sandboxDispose: () => Promise<void>
  runtimeSend: (clientId: number, message: unknown) => void
  runtimeClose: (clientId: number) => void
  sandboxTransportStats: () => TransportCounters
  sandboxCanonicalStats: () => CanonicalStats
}

const compiledBrokers = new Map<string, string>()
export const windowsSandboxSourceNames = Object.freeze([
  "GuardSandbox.cs",
  "GuardSharedLabels.cs",
  "GuardDeniedDirectories.cs",
  "CanonicalMetadata.cs",
])
/** 列出 Windows 沙箱辅助程序的构建输入及其摘要。 */
function windowsSandboxBuildInputs(repository: string) {
  const sources = windowsSandboxSourceNames.map(name => ({
    file: path.join(repository, "native/windows", name),
    bytes: fs.readFileSync(path.join(repository, "native/windows", name)),
  }))
  const digest = createHash("sha256")
  for (const source of sources)
    digest.update(path.basename(source.file)).update("\0").update(source.bytes).update("\0")
  const cachePreparation = path.join(repository, "native/windows/PrepareBrokerCache.ps1")
  digest.update("PrepareBrokerCache.ps1\0").update(fs.readFileSync(cachePreparation))
  return { sources, cachePreparation, digest: digest.digest("hex") }
}
/** 按私有构建缓存的相同顺序计算摘要，不编译或修改权限。 */
export function windowsSandboxBuildDigest(repository: string): string {
  return windowsSandboxBuildInputs(repository).digest
}

/** 创建并校验沙箱使用的真实目录。 */
function safeDirectory(directory: string): string {
  const absolute = path.resolve(directory)
  let existing = absolute
  while (!exists(existing)) existing = path.dirname(existing)
  if (!isDirectory(entryStat(existing)) || lower(realpath(existing)) !== lower(existing))
    throw new Error(M.sandbox.dirReparse(absolute))
  createDirectory(absolute, { recursive: true })
  if (!isDirectory(entryStat(absolute)) || lower(realpath(absolute)) !== lower(absolute))
    throw new Error(M.sandbox.dirReparse(absolute))
  return absolute
}

/** 解析可写授权文件，禁止越出根目录。 */
function safeWritableFile(root: string, value: string): string {
  const absolute = path.resolve(root, value)
  if (!within(root, absolute) || absolute === root) throw new Error(M.sandbox.writableChild)
  let cursor = absolute
  while (cursor !== path.dirname(cursor)) {
    const stat = entryStat(cursor)
    if (isSymbolicLink(stat)) throw new Error(M.sandbox.writableReparse)
    cursor = path.dirname(cursor)
  }
  const stat = entryStat(absolute)
  if (!isFile(stat) || stat.nlink !== 1 || lower(realpath(absolute)) !== lower(absolute))
    throw new Error(M.sandbox.writableOrdinary)
  return absolute
}

/** 创建会话私有目录。 */
function privateSession(session: string): string {
  const parent = temporaryRoot,
    absolute = path.resolve(session)
  if (
    lower(path.dirname(absolute)) !== lower(parent) ||
    !/^yunzai-guard-windows-[\w-]+$/.test(path.basename(absolute))
  )
    throw new Error(M.sandbox.cleanupOutside)
  if (exists(absolute) && lower(realpath(absolute)) !== lower(absolute))
    throw new Error(M.sandbox.sessionReparse)
  return absolute
}

/** 回收上次异常退出遗留的沙箱会话。 */
function recoverPrevious(helper: string, activePath: string, root: string): void {
  if (!exists(activePath)) return
  const stat = entryStat(activePath)
  if (!isFile(stat) || stat.nlink !== 1 || stat.size > 8192) throw new Error(M.sandbox.ownerRecord)
  const active = parse(readFile(activePath, "utf8")) as {
    root?: unknown
    session?: unknown
  }
  if (active.root !== root || typeof active.session !== "string")
    throw new Error(M.sandbox.ownerMismatch)
  const session = privateSession(active.session),
    journal = path.join(session, "journal.json")
  if (exists(journal)) {
    const result = spawnSync(helper, ["--cleanup", journal], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 15000,
    })
    if (result.status !== 0 || exists(journal))
      throw new Error(M.sandbox.previousCleanup(result.stdout, result.stderr))
  }
  fs.rmSync(session, { recursive: true, force: true })
  removeOwned(activePath)
}

/** 校验预编译的 Windows 沙箱辅助程序并返回其路径。 */
export function compileWindowsSandbox(): string {
  if (process.platform !== "win32") throw new Error(M.sandbox.appContainerOnly)
  const repository = fileURLToPath(new URL("../../", import.meta.url))
  const { cachePreparation, digest } = windowsSandboxBuildInputs(repository)
  const bundled = windowsBroker(repository, digest)
  const cacheDigest = createHash("sha256").update(digest).update(bundled.sha256).digest("hex")
  const known = compiledBrokers.get(cacheDigest)
  if (known) return verifyFile(known, bundled.sha256)
  const systemRoot = process.env.SystemRoot || "C:\\Windows"
  const preparation = spawnSync(
    path.join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      cachePreparation,
      "-Digest",
      cacheDigest,
    ],
    { windowsHide: true, encoding: "utf8", timeout: 15000 },
  )
  if (preparation.status !== 0) throw new Error(M.sandbox.brokerCache(preparation.stderr))
  const preparedPath = preparation.stdout.trim()
  if (!path.isAbsolute(preparedPath)) throw new Error(M.sandbox.brokerCachePath)
  // 打包的 Windows 宿主可能在没有文件系统 reparse point 时重定向 LocalAppData。
  // 引导过程核验所有者和 ACL，使用核验后的规范路径。
  const cache = realpath(preparedPath)
  if (
    path.basename(cache) !== cacheDigest ||
    path.basename(path.dirname(cache)) !== "WindowsSandboxBrokers" ||
    within(repository, cache) ||
    within(cache, repository)
  )
    throw new Error(M.sandbox.brokerCacheIdentity)
  const target = path.join(cache, "GuardSandbox.exe")
  if (target.length > 240) throw new Error(M.sandbox.brokerPathLong)
  if (exists(target)) {
    verifyFile(target, bundled.sha256)
    compiledBrokers.set(cacheDigest, target)
    return target
  }
  try {
    fs.copyFileSync(bundled.executable, target, fs.constants.COPYFILE_EXCL)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  verifyFile(target, bundled.sha256)
  compiledBrokers.set(cacheDigest, target)
  return target
}

/** 仅重放当前 broker 会话创建的所有者私有日志，不清理其他会话。 */
export async function cleanupWindowsSandbox(helper: string, session: string): Promise<void> {
  privateSession(session)
  const journal = path.join(session, "journal.json")
  let error = ""
  for (let attempt = 0; attempt < 10 && exists(journal); attempt++) {
    const result = spawnSync(helper, ["--cleanup", journal], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 10000,
    })
    if (result.status === 0) break
    error = `${result.stdout}${result.stderr}`
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (exists(journal)) throw new Error(M.sandbox.cleanupJournal(journal, error))
  fs.rmSync(session, { recursive: true, force: true })
}

/** ChildProcess 指原生 broker；sandboxPid 是 broker 核验的实际 Yunzai PID。 */
export function spawnWindowsSandbox(
  projectRoot: string,
  settings: WindowsSandboxSettings,
  options: WindowsSandboxLaunch,
): WindowsSandboxProcess {
  if (process.platform !== "win32") throw new Error(M.sandbox.appContainerOnly)
  const runtimeManifest = options.runtimeManifest
  const sessionKey = options.sessionKey
  if (runtimeManifest !== undefined && (typeof runtimeManifest !== "string" || !runtimeManifest))
    throw new Error(M.sandbox.manifestDir)
  if (
    sessionKey !== undefined &&
    (typeof sessionKey !== "string" || !regexpExec(/^[a-z][a-z0-9-]{0,63}$/, sessionKey))
  )
    throw new Error(M.sandbox.sessionKey)
  if (options.canonicalMetadataProtocol !== undefined && options.canonicalMetadataProtocol !== 1)
    throw new Error(M.sandbox.metadataProtocol)
  const root = realpath(projectRoot)
  const managed = ownDescriptor(globalThis, runtimeKey) !== undefined
  if (managed && lower(root) !== lower(initialRoot)) throw new Error(M.sandbox.writableDir)
  const statePath = path.join(root, "data/yunzai-guard")
  const writablePaths = (
    settings.sandbox?.writablePaths ?? ["data", "temp", "logs", "config/config"]
  ).map(item => {
    const directory = path.resolve(root, item)
    if (
      !within(root, directory) ||
      directory === root ||
      within(statePath, directory) ||
      (managed && (within(guardRoot, directory) || within(directory, guardRoot)))
    )
      throw new Error(M.sandbox.writableDir)
    return directory
  })
  const helper = compileWindowsSandbox()
  const state = safeDirectory(statePath)
  const activePath = path.join(
    state,
    sessionKey ? `windows-sandbox-${sessionKey}-active.json` : "windows-sandbox-active.json",
  )
  recoverPrevious(helper, activePath, root)
  const session = createTemporary(path.join(temporaryRoot, "yunzai-guard-windows-"))
  let child: WindowsSandboxProcess
  try {
    const runtime = safeDirectory(path.join(session, "runtime"))
    const executable = path.join(runtime, "node.exe")
    const executableBytes = fs.readFileSync(options.executable)
    const sourceDigest = createHash("sha256").update(executableBytes).digest("hex")
    if (
      options.expectedExecutableSha256 !== undefined &&
      options.expectedExecutableSha256 !== sourceDigest
    )
      throw new Error(M.sandbox.executableChanged)
    writeOwned(executable, executableBytes)
    if (createHash("sha256").update(fs.readFileSync(executable)).digest("hex") !== sourceDigest)
      throw new Error(M.sandbox.executableDigest)
    const writable = writablePaths.map(safeDirectory)
    const reads = [runtime]
    if ((options.additionalDeniedPaths?.length ?? 0) > 16) throw new Error(M.sandbox.denyLimit)
    const denied = (options.additionalDeniedPaths ?? []).map(value => {
      const directory = path.resolve(root, value)
      if (
        directory.toLowerCase() === root.toLowerCase() ||
        !within(root, directory) ||
        writable.some(write => within(write, directory) || within(directory, write))
      )
        throw new Error(M.sandbox.denyDirs)
      return safeDirectory(directory)
    })
    const shared = validateNativeWritablePaths(options.sharedWritablePaths).map(value => {
      const directory = path.resolve(root, value)
      if (!writable.includes(directory)) throw new Error(M.sandbox.sharedDirs)
      return directory
    })
    const defaultConfig = path.join(root, "config/default_config")
    const writableFiles = validateNativeWritableFiles(
      settings.sandbox?.writableFiles,
      "Windows sandbox writableFiles",
      exists(defaultConfig) ? fs.readdirSync(defaultConfig) : [],
    ).map(value => safeWritableFile(root, value))
    if (
      writableFiles.some(
        file => within(state, file) || writable.some(directory => within(directory, file)),
      )
    )
      throw new Error(M.sandbox.exactFiles)
    const dependencyRoots = writable
      .filter(
        directory =>
          path.dirname(directory).toLowerCase() === path.join(root, "plugins").toLowerCase(),
      )
      .map(directory => path.join(directory, "node_modules"))
    const aliases =
      runtimeManifest ||
      dependencyRoots.some(directory => entryStat(directory, { throwIfNoEntry: false }))
        ? collectWindowsAliases(
            root,
            writable.map(directory => path.relative(root, directory)),
            writableFiles.map(file => path.relative(root, file)),
          )
        : undefined
    const approvedLinks =
      aliases?.links.filter(link =>
        dependencyRoots.some(directory => within(directory, path.resolve(root, link.from))),
      ) ?? []
    const coreBacklinks =
      aliases?.skippedCoreBacklinks?.filter(link =>
        dependencyRoots.some(directory => within(directory, path.resolve(root, link.from))),
      ) ?? []
    let readonlyLinks: string | undefined
    if (approvedLinks.length || coreBacklinks.length) {
      readonlyLinks = path.join(runtime, "readonly-links.json")
      const text = stringify({ version: 1, root, links: approvedLinks, coreBacklinks })
      if (Buffer.byteLength(text) > 6 * 1024 * 1024) throw new Error(M.sandbox.linkManifest)
      writeOwned(readonlyLinks, text, 0o400)
    }
    if (runtimeManifest) {
      const manifest = realpath(runtimeManifest)
      const directory = path.dirname(manifest)
      const manifestStat = entryStat(runtimeManifest)
      if (
        !path.isAbsolute(runtimeManifest) ||
        path.basename(manifest) !== "manifest.json" ||
        lower(path.dirname(directory)) !== lower(temporaryRoot) ||
        !regexpExec(/^yunzai-(?:guard|native)-runtime-[A-Za-z0-9-]+$/, path.basename(directory)) ||
        lower(manifest) !== lower(path.resolve(runtimeManifest)) ||
        !isFile(manifestStat) ||
        isSymbolicLink(manifestStat) ||
        manifestStat.nlink !== 1 ||
        manifestStat.size > 8 * 1024 * 1024 ||
        within(root, directory) ||
        within(state, directory) ||
        within(directory, state) ||
        writable.some(write => within(write, directory))
      ) {
        privateSession(session)
        fs.rmSync(session, { recursive: true, force: true })
        throw new Error(M.sandbox.manifestDir)
      }
      reads.push(safeDirectory(directory))
      const manifestData = parse(readFile(manifest, "utf8")) as Record<string, unknown>
      if (
        !manifestData ||
        typeof manifestData !== "object" ||
        Array.isArray(manifestData) ||
        manifestData.version !== 1 ||
        typeof manifestData.endpoint !== "string" ||
        !regexpExec(
          /^\\\\\.\\pipe\\yunzai-guard-(?:runtime|native)-[A-Za-z0-9-]+$/,
          manifestData.endpoint,
        )
      )
        throw new Error(M.sandbox.manifestPipe)
      manifestData.moduleAliases = aliases
      const serialized = stringify(manifestData)
      if (Buffer.byteLength(serialized) > 8 * 1024 * 1024)
        throw new Error(M.sandbox.manifestAliases)
      changeMode(manifest, 0o600)
      try {
        writeOwned(manifest, serialized, 0o600, true)
      } finally {
        changeMode(manifest, 0o400)
      }
    }
    const args = [
      "--root",
      root,
      "--journal",
      path.join(session, "journal.json"),
      "--read",
      runtime,
      "--network",
      settings.sandbox?.network ?? "none",
    ]
    if (options.canonicalMetadataProtocol === 1) args.push("--canonical-metadata", "1")
    if (runtimeManifest) {
      const manifest = parse(readFile(runtimeManifest, "utf8")) as {
        endpoint?: unknown
      }
      if (typeof manifest.endpoint !== "string") throw new Error(M.sandbox.manifestPipe)
      args.push("--pipe", manifest.endpoint)
    }
    if (options.forwardOutput === false) args.push("--discard-output", "true")
    if (readonlyLinks) args.push("--readonly-links", readonlyLinks)
    for (const directory of reads.slice(1)) args.push("--read", directory)
    for (const directory of writable)
      args.push(shared.includes(directory) ? "--shared-write" : "--write", directory)
    for (const file of writableFiles) args.push("--write-file", file)
    for (const directory of denied) args.push("--deny", directory)
    args.push(
      "--deny",
      state,
      "--cwd",
      options.cwd ?? root,
      "--",
      executable,
      "--preserve-symlinks",
      "--preserve-symlinks-main",
      ...options.args,
    )
    writeOwned(activePath, stringify({ root, session }))
    child = spawn(helper, args, {
      cwd: root,
      env: options.prependRuntimePath
        ? prependWindowsRuntimePath(options.env, runtime)
        : options.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }) as WindowsSandboxProcess
  } catch (error) {
    privateSession(session)
    fs.rmSync(session, { recursive: true, force: true })
    if (exists(activePath)) {
      const active = parse(readFile(activePath, "utf8")) as { session?: unknown }
      if (active.session === session) removeOwned(activePath)
    }
    throw error
  }
  child.sandboxSession = session
  let exited = false
  const transportCounters = createTransportCounters()
  child.sandboxTransportStats = () => structuredClone(transportCounters)
  const canonical = createCanonicalObserver(options.canonicalMetadataProtocol === 1)
  child.sandboxCanonicalStats = canonical.stats
  let resolveExited: () => void
  const originalExit = new Promise<void>(resolve => {
    resolveExited = resolve
  })
  let resolveOutputClosed: () => void
  const nativeOutputClosed = new Promise<void>(resolve => {
    resolveOutputClosed = resolve
  })
  let buffered = ""
  let outputFailed = false
  let stderr = ""
  let diagnosticBuffered = ""
  let diagnosticOversize = false
  const consumeDiagnostic = (line: string) => {
    const prefix = "canonical-metadata-final "
    if (!line.startsWith(prefix)) return
    if (Buffer.byteLength(line) > 2048) {
      canonical.invalid("cleanup")
      return
    }
    try {
      const value = JSON.parse(line.slice(prefix.length)) as Record<string, unknown>
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 2 ||
        !("snapshot" in value) ||
        !("cleanupConfirmed" in value)
      ) {
        canonical.invalid("cleanup")
        return
      }
      canonical.record("cleanup", value.snapshot, value.cleanupConfirmed)
    } catch {
      canonical.invalid("cleanup")
    }
  }
  let cleanupStarted = false
  let resolveCleanup: () => void
  let rejectCleanup: (error: Error) => void
  child.sandboxCleanup = new Promise<void>((resolve, reject) => {
    resolveCleanup = resolve
    rejectCleanup = reject
  })
  // 向调用方保留拒绝结果，同时避免未处理拒绝终止宿主。
  void child.sandboxCleanup.catch(() => {})
  const finishCleanup = () => {
    if (cleanupStarted) return
    cleanupStarted = true
    void cleanupWindowsSandbox(helper, session)
      .then(() => {
        try {
          const active = parse(readFile(activePath, "utf8")) as { session?: string }
          if (active.session === session) removeOwned(activePath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
        resolveCleanup!()
      })
      .catch(rejectCleanup!)
  }
  const write = (message: unknown, callback?: (error: Error | null) => void): boolean =>
    writeControl(child.stdin, !exited, message, transportCounters.control, callback)
  Object.defineProperty(child, "connected", { get: () => !exited })
  child.send = ((message: unknown, callback?: (error: Error | null) => void) =>
    write({ type: "ipc", message }, callback)) as ChildProcess["send"]
  child.runtimeSend = (clientId, message) => {
    write({ type: "ipc", clientId, message })
  }
  child.runtimeClose = clientId => {
    write({ type: "close", clientId })
  }
  let disposePromise: Promise<void> | undefined
  child.sandboxDispose = () => {
    // 撤销继承 ACE 可能遍历大量插件资源；stop 立即发送，
    // 但系统权限恢复须有独立于插件宽限期的最短等待时间。
    const timeout = Math.max(30000, (settings.shutdownTimeout ?? 10000) + 5000)
    return (disposePromise ??= disposeProcess({
      stop: () => {
        write({ type: "stop" })
      },
      hasExited: () => exited,
      kill: () => {
        if (!child.kill("SIGKILL") && !exited) throw new Error(M.sandbox.brokerTermination)
      },
      exited: originalExit,
      cleanup: Promise.allSettled([child.sandboxCleanup, nativeOutputClosed]).then(results => {
        const errors = results.flatMap(result =>
          result.status === "rejected" ? [result.reason] : [],
        )
        if (errors.length) throw new AggregateError(errors, M.sandbox.cleanupDrain)
      }),
      timeout,
    }))
  }
  child.stdin?.on("error", () => {})
  child.stderr?.setEncoding("utf8")
  child.stdout?.setEncoding("utf8")
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8192)
    for (const part of chunk.split(/(?<=\n)/)) {
      if (!diagnosticOversize) diagnosticBuffered += part
      if (Buffer.byteLength(diagnosticBuffered) > 4096) {
        if (diagnosticBuffered.startsWith("canonical-metadata-final ")) canonical.invalid("cleanup")
        diagnosticBuffered = ""
        diagnosticOversize = true
      }
      if (part.endsWith("\n")) {
        if (!diagnosticOversize) consumeDiagnostic(diagnosticBuffered.trimEnd())
        diagnosticBuffered = ""
        diagnosticOversize = false
      }
    }
  })
  child.stdout?.on("data", (chunk: string) => {
    if (outputFailed) return // 拒绝畸形输出后仍持续排空原生流。
    buffered += chunk
    if (Buffer.byteLength(buffered) > 1024 * 1024) {
      outputFailed = true
      buffered = ""
      try {
        child.emit("error", new Error(M.sandbox.brokerOutput))
      } finally {
        child.stdin?.end()
      }
      return
    }
    while (buffered.includes("\n")) {
      const index = buffered.indexOf("\n"),
        line = buffered.slice(0, index)
      buffered = buffered.slice(index + 1)
      if (!line) continue
      try {
        const frame = JSON.parse(line) as Record<string, unknown>
        if (frame.type === "ready") {
          if (!Number.isSafeInteger(frame.pid) || frame.appContainer !== true)
            throw new Error(M.sandbox.identity)
          child.sandboxPid = Number(frame.pid)
          canonical.record("ready", frame.canonicalMetadata)
          child.emit("sandbox-ready", frame)
        } else if (frame.type === "exit") {
          canonical.record("exit", frame.canonicalMetadata)
        } else if (frame.type === "ipc") {
          if (!Number.isSafeInteger(frame.pid) || !Number.isSafeInteger(frame.clientId))
            throw new Error(M.sandbox.runtimeIdentity)
          const message = frame.message as { type?: string } | null
          if (
            frame.pid === child.sandboxPid &&
            message?.type === "preload-hello" &&
            !child.sandboxClientId
          )
            child.sandboxClientId = Number(frame.clientId)
          if (frame.clientId === child.sandboxClientId) {
            child.emit("message", frame.message)
          } else
            child.emit("runtime-message", {
              clientId: Number(frame.clientId),
              pid: Number(frame.pid),
              message: frame.message,
            })
        } else if (frame.type === "ipc-close") {
          transportCounters.native.closed = addCounter(transportCounters.native.closed)
          const nativeCounters = frame.transportCounters as Record<string, unknown> | undefined
          for (const key of ["rejected", "unknown"] as const) {
            const value = nativeCounters?.[key]
            if (Number.isSafeInteger(value) && Number(value) >= 0)
              transportCounters.native[key] = addCounter(
                transportCounters.native[key],
                Number(value),
              )
          }
          child.emit("runtime-close", { clientId: Number(frame.clientId), pid: Number(frame.pid) })
          if (frame.clientId === child.sandboxClientId && !exited) child.emit("disconnect")
        } else if (frame.type === "control-rejected") {
          transportCounters.native.rejected = addCounter(transportCounters.native.rejected)
        } else if (frame.type === "stdout" || frame.type === "stderr") {
          if (options.forwardOutput !== false && typeof frame.base64 === "string")
            forwardOutput(
              frame.type === "stdout" ? process.stdout : process.stderr,
              Buffer.from(frame.base64, "base64"),
              transportCounters.output,
            )
        } else if (frame.type === "error" || frame.type === "transport-error") {
          child.emit(
            "error",
            new Error(
              M.sandbox.windowsError(String(frame.message), String(frame.code ?? "unknown")),
            ),
          )
        }
      } catch (error) {
        outputFailed = true
        buffered = ""
        try {
          child.emit("error", error)
        } finally {
          child.stdin?.end()
        }
        return
      }
    }
  })
  child.once("exit", (code, signal) => {
    exited = true
    canonical.nativeExit(code, signal)
    resolveExited!()
    finishCleanup()
  })
  child.once("error", () => {
    if (!child.pid) {
      exited = true
      resolveExited!()
      finishCleanup()
    }
  })
  child.once("close", () => {
    if (diagnosticBuffered && !diagnosticOversize) consumeDiagnostic(diagnosticBuffered.trimEnd())
    canonical.outputClosed()
    resolveOutputClosed!()
    if (stderr) child.emit("sandbox-diagnostic", stderr)
  })
  return child
}
