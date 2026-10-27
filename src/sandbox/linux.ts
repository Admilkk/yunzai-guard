import fs from "node:fs"
import os from "node:os"
import nodePath from "node:path"
import { randomUUID } from "node:crypto"
import type { ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { Readable } from "node:stream"
import { validateNativeWritableFiles } from "../native-sandbox/config.js"
import { linuxSandboxIdentity } from "./linux-identity.js"
import { prepareBubblewrap } from "../dependencies/linux-bwrap.js"
import { within } from "../protect/paths.js"
import { M } from "../shared/messages.js"

const path = Object.freeze({ ...nodePath })
const createId = randomUUID
const createDirectory = fs.mkdirSync.bind(fs)
const openFile = fs.openSync.bind(fs)
const writeFile = fs.writeSync.bind(fs)
const closeFile = fs.closeSync.bind(fs)
const removeFile = fs.unlinkSync.bind(fs)
const bytes = Buffer.from.bind(Buffer)
const runtimeKey = Symbol.for("yunzai.guard.runtime.v1")
const initialRoot = (() => {
  try {
    return fs.realpathSync.native(process.cwd())
  } catch {
    return path.resolve(process.cwd())
  }
})()
const ownDescriptor = Object.getOwnPropertyDescriptor.bind(Object)

export interface LinuxSandboxSettings {
  sandbox?: {
    network: "none" | "host"
    writablePaths: string[]
    writableFiles?: string[]
    /** 原生插件 IPC 使用继承的 FD3，无需向外 connect/send。 */
    denyNetworkCalls?: boolean
    bwrapPath?: string
  }
}

export interface LinuxSandboxLaunch {
  executable: string
  args: string[]
  env: NodeJS.ProcessEnv
  runtimeManifest: string
}

export interface LinuxSandboxSpec {
  executable: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  extraStdio: Array<{ fd: number; source: number }>
  pidNamespace: true
  statusFd: 5
  network: "none" | "host"
  dispose: () => void
  observe: (child: ChildProcess) => void
  waitForExit: (child: ChildProcess, timeoutMs?: number) => Promise<void>
}

const syscallTables = {
  x64: {
    auditArch: 0xc000003e,
    clone: 56,
    outbound: [42, 44, 46, 307], // 出站调用：connect、sendto、sendmsg、sendmmsg
    denied: [
      101, 155, 165, 166, 169, 175, 176, 246, 248, 249, 250, 272, 298, 304, 308, 310, 311, 313, 320,
      321, 323,
    ],
  },
  arm64: {
    auditArch: 0xc00000b7,
    clone: 220,
    outbound: [203, 206, 211, 269],
    denied: [
      39, 40, 41, 97, 104, 105, 106, 117, 142, 217, 218, 219, 241, 265, 268, 270, 271, 273, 280,
      282, 294,
    ],
  },
} as const

/** 在命名空间之上增加少量拒绝规则，不提供通用系统调用白名单。 */
export function linuxSeccompFilter(architecture = process.arch, denyNetworkCalls = false): Buffer {
  if (os.endianness() !== "LE" || !(architecture in syscallTables))
    throw new Error(M.sandbox.syscallArch(architecture))
  const table = syscallTables[architecture as keyof typeof syscallTables]
  const instructions: Array<[number, number, number, number]> = []
  const add = (code: number, jt: number, jf: number, value: number) =>
    instructions.push([code, jt, jf, value])
  add(0x20, 0, 0, 4) // 读取 seccomp_data.arch
  add(0x15, 1, 0, table.auditArch)
  add(0x06, 0, 0, 0x80000000) // ABI 不符合预期时返回 SECCOMP_RET_KILL_PROCESS
  add(0x20, 0, 0, 0) // 读取 seccomp_data.nr
  if (architecture === "x64") {
    add(0x35, 0, 1, 0x40000000) // 同时拒绝 x32 ABI
    add(0x06, 0, 0, 0x00050026) // 返回 ENOSYS
  }
  for (const number of [
    ...table.denied,
    428,
    429,
    430,
    431,
    432,
    433,
    438,
    442,
    ...(denyNetworkCalls ? [...table.outbound, 425, 426, 427] : []),
  ]) {
    add(0x15, 0, 1, number)
    add(0x06, 0, 0, 0x00050001) // 返回 EPERM
  }
  add(0x15, 0, 1, 435) // clone3 使用间接 flags 结构，此处强制 libc 回退
  add(0x06, 0, 0, 0x00050026)
  add(0x15, 0, 3, table.clone)
  add(0x20, 0, 0, 16) // clone flags，取 args[0] 低位字
  add(0x45, 0, 1, 0x7e020080) // 新建命名空间标志：NEW{CGROUP,UTS,IPC,USER,PID,NET,MOUNT}
  add(0x06, 0, 0, 0x00050001)
  add(0x06, 0, 0, 0x7fff0000) // 允许系统调用
  const result = Buffer.alloc(instructions.length * 8)
  instructions.forEach(([code, jt, jf, value], index) => {
    result.writeUInt16LE(code, index * 8)
    result.writeUInt8(jt, index * 8 + 2)
    result.writeUInt8(jf, index * 8 + 3)
    result.writeUInt32LE(value, index * 8 + 4)
  })
  return result
}

/** 在根目录下逐级创建目标目录，拒绝经过符号链接。 */
function directory(root: string, target: string): void {
  let current = root
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      const stat = fs.lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(M.sandbox.writableSymlink(target))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      createDirectory(current)
    }
  }
}

/** 确认会话状态目录只包含 Guard 自己的私有文件。 */
function stateIsPrivate(state: string): void {
  for (const entry of fs.readdirSync(state, { withFileTypes: true })) {
    const target = path.join(state, entry.name)
    const stat = fs.lstatSync(target)
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1))
      throw new Error(M.sandbox.stateLinked)
    if (stat.isDirectory()) stateIsPrivate(target)
  }
}

/** 确认可写授权文件均为私有普通文件。 */
function writableFilesArePrivate(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    const stat = fs.lstatSync(target)
    if (stat.isFile() && stat.nlink !== 1) throw new Error(M.sandbox.writableHardlink(target))
    if (stat.isDirectory()) writableFilesArePrivate(target)
  }
}

interface NamespaceIdentity {
  pid: number
  startTicks?: string
  gone: boolean
}

/** 读取进程身份，用于确认沙箱进程未被替换。 */
function processIdentity(
  pid: number,
): { startTicks: string; state: string; parent: number } | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")
    const startTicks = fields[19]
    if (!startTicks || !/^\d+$/.test(startTicks)) throw new Error(M.sandbox.namespaceStat)
    return { startTicks, state: fields[0]!, parent: Number(fields[1]) }
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined
    throw error
  }
}

/** 跟踪 bubblewrap 命名空间进程的生命周期。 */
function namespaceLifecycle() {
  const observations = new WeakMap<
    ChildProcess,
    {
      identity?: NamespaceIdentity
      error?: Error
      ended: boolean
      input: string
    }
  >()
  const observe = (child: ChildProcess): void => {
    if (observations.has(child)) return
    const observation: {
      identity?: NamespaceIdentity
      error?: Error
      ended: boolean
      input: string
    } = {
      ended: false,
      input: "",
    }
    observations.set(child, observation)
    const stream = child.stdio.at(5) as Readable | null | undefined
    if (!stream || typeof stream.on !== "function") {
      observation.error = new Error(M.sandbox.statusPipe)
      return
    }
    stream.on("data", (chunk: Buffer) => {
      if (observation.error) return
      observation.input += chunk.toString()
      if (observation.input.length > 65536) {
        observation.error = new Error(M.sandbox.statusLimit)
        return
      }
      while (observation.input.includes("\n")) {
        const split = observation.input.indexOf("\n")
        const line = observation.input.slice(0, split)
        observation.input = observation.input.slice(split + 1)
        if (!line.trim()) continue
        try {
          const record = JSON.parse(line) as Record<string, unknown>
          if (record["child-pid"] === undefined) continue
          const pid = Number(record["child-pid"])
          if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || pid === child.pid)
            throw new Error(M.sandbox.initIdentity)
          if (observation.identity) {
            if (observation.identity.pid !== pid) throw new Error(M.sandbox.initChanged)
            continue
          }
          const current = processIdentity(pid)
          if (
            current &&
            current.parent !== child.pid &&
            !/^(?:Z|X)$/.test(current.state) &&
            child.exitCode === null &&
            child.signalCode === null
          )
            throw new Error(M.sandbox.initForeign)
          observation.identity = { pid, startTicks: current?.startTicks, gone: !current }
        } catch (error) {
          observation.error = error as Error
        }
      }
    })
    stream.on("error", error => {
      observation.error = error
    })
    stream.once("end", () => {
      observation.ended = true
    })
    stream.once("close", () => {
      observation.ended = true
    })
  }
  const waitForExit = async (child: ChildProcess, timeoutMs = 5000): Promise<void> => {
    observe(child)
    const observation = observations.get(child)!
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (observation.error) throw observation.error
      if (child.exitCode !== null || child.signalCode !== null) {
        const identity = observation.identity
        if (identity?.gone) return
        if (identity) {
          const current = processIdentity(identity.pid)
          // 只有 zap_pid_ns_processes 等待全部命名空间成员退出后，init 才进入 Z/X。
          // 启动身份变化说明原 init 已回收，无需向数字 PID 发信号。
          if (
            !current ||
            current.startTicks !== identity.startTicks ||
            /^(?:Z|X)$/.test(current.state)
          )
            return
        } else if (observation.ended) throw new Error(M.sandbox.initExitUnknown)
      }
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    throw new Error(M.sandbox.initCleanup)
  }
  return { observe, waitForExit }
}

/**
 * FD 3 保留私有 Node IPC，FD 4 传递只读 seccomp 程序。
 * spawn 后必须调用 dispose() 关闭父进程 FD，错误路径也不例外。
 */
export function buildLinuxSandbox(
  projectRoot: string,
  settings: LinuxSandboxSettings,
  launch: LinuxSandboxLaunch,
): LinuxSandboxSpec {
  if (process.platform !== "linux") throw new Error(M.sandbox.linuxOnly)
  const root = fs.realpathSync(projectRoot)
  if (ownDescriptor(globalThis, runtimeKey) && root !== initialRoot)
    throw new Error(M.sandbox.writableRoot)
  const network = settings.sandbox?.network ?? "none"
  if (network !== "none" && network !== "host") throw new Error(M.sandbox.network)
  const executable = prepareBubblewrap(
    fileURLToPath(new URL("../../", import.meta.url)),
    settings.sandbox?.bwrapPath,
    network,
  )
  if (settings.sandbox?.denyNetworkCalls && network !== "none")
    throw new Error(M.sandbox.outboundNone)
  const filter = linuxSeccompFilter(process.arch, settings.sandbox?.denyNetworkCalls ?? false)
  const userIdentity = linuxSandboxIdentity(os.userInfo())
  const plugin = fs.realpathSync(fileURLToPath(new URL("../../", import.meta.url)))
  const state = path.join(root, "data/yunzai-guard")
  const writable = (
    settings.sandbox?.writablePaths ?? ["data", "temp", "logs", "config/config"]
  ).map(part => {
    if (!part || path.isAbsolute(part) || part.split(/[\\/]/).includes(".."))
      throw new Error(M.sandbox.writableRelative)
    const target = path.resolve(root, part)
    if (
      target === root ||
      !within(root, target) ||
      within(state, target) ||
      (within(root, plugin) && (within(target, plugin) || within(plugin, target)))
    )
      throw new Error(M.sandbox.writableRoot)
    return target
  })
  for (const target of writable) {
    directory(root, target)
    writableFilesArePrivate(target)
  }
  const coreDefaults = path.join(root, "config/default_config")
  const writableFiles = validateNativeWritableFiles(
    settings.sandbox?.writableFiles ?? [],
    "sandbox.writableFiles",
    fs.existsSync(coreDefaults) ? fs.readdirSync(coreDefaults) : [],
  ).map(part => {
    if (!part || path.isAbsolute(part) || part.split(/[\\/]/).includes(".."))
      throw new Error(M.sandbox.writableFileRelative)
    const target = path.resolve(root, part)
    if (
      !within(root, target) ||
      target === root ||
      within(plugin, target) ||
      within(target, plugin)
    )
      throw new Error(M.sandbox.writableFileSource)
    // 要求文件已经存在，避免启动时创建或替换业务数据。
    // 逐级检查祖先路径，即使最终 realpath 恰好返回项目内也不例外。
    let ancestor = root
    for (const segment of path
      .relative(root, path.dirname(target))
      .split(path.sep)
      .filter(Boolean)) {
      ancestor = path.join(ancestor, segment)
      const stat = fs.lstatSync(ancestor)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(M.sandbox.writableAncestor)
    }
    const stat = fs.lstatSync(target)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      fs.realpathSync(target) !== target
    )
      throw new Error(M.sandbox.writableFileLinked)
    return target
  })
  if (writableFiles.some(file => within(state, file))) throw new Error(M.sandbox.writableFileState)
  directory(root, state)
  stateIsPrivate(state)
  const manifest = path.resolve(launch.runtimeManifest)
  const broker = path.join(path.dirname(manifest), "broker.sock")
  if (
    !path.isAbsolute(launch.runtimeManifest) ||
    !fs.lstatSync(manifest).isFile() ||
    fs.lstatSync(manifest).isSymbolicLink() ||
    !fs.lstatSync(broker).isSocket()
  )
    throw new Error(M.sandbox.manifestSocket)

  const args = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
  ]
  if (network === "none") args.push("--unshare-net")
  for (const target of ["/usr", "/bin", "/sbin", "/lib", "/lib64"])
    if (fs.existsSync(target)) args.push("--ro-bind", target, target)
  for (const target of [
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/nsswitch.conf",
    "/etc/ssl",
    "/etc/fonts",
    "/etc/localtime",
  ])
    if (fs.existsSync(target)) args.push("--ro-bind", target, target)
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/home")
  args.push("--ro-bind-data", "6", "/etc/passwd", "--ro-bind-data", "7", "/etc/group")
  const application = fs.realpathSync(launch.executable)
  if (!fs.statSync(application).isFile()) throw new Error(M.sandbox.executableFile)
  if (writable.some(target => within(target, application)))
    throw new Error(M.sandbox.writableExecutable)
  fs.accessSync(application, fs.constants.X_OK)
  if (!["/usr", "/bin", "/sbin", "/lib", "/lib64", root].some(base => within(base, application)))
    args.push("--dir", path.dirname(application), "--ro-bind", application, application)
  args.push("--ro-bind", root, root)
  for (const target of writable) args.push("--bind", target, target)
  for (const target of writableFiles) args.push("--bind", target, target)
  args.push("--tmpfs", state, "--remount-ro", state, "--chdir", root)
  args.push(
    "--dir",
    path.dirname(manifest),
    "--ro-bind",
    manifest,
    manifest,
    "--ro-bind",
    broker,
    broker,
  )

  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(launch.env)) {
    if (
      value === undefined ||
      /^(?:LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|HOME$|PWD$|GCONV_PATH$|GLIBC_TUNABLES$)/.test(
        key,
      )
    )
      continue
    env[key] = value
  }
  env.PATH = launch.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"
  args.push("--setenv", "PATH", env.PATH, "--setenv", "HOME", "/home")
  args.push(
    "--setenv",
    "NODE_CHANNEL_FD",
    "3",
    "--setenv",
    "NODE_CHANNEL_SERIALIZATION_MODE",
    "json",
  )
  args.push("--seccomp", "4", "--json-status-fd", "5", application, ...launch.args)

  const extraStdio: LinuxSandboxSpec["extraStdio"] = []
  try {
    for (const [fd, content] of [
      [4, filter],
      [6, userIdentity.passwd],
      [7, userIdentity.group],
    ] as const) {
      const filename = path.join(state, `sandbox-input-${createId()}`)
      let source: number | undefined
      let created = false
      try {
        // 保持偏移为零，移除路径后仅将匿名自有 FD 交给 bwrap。
        source = openFile(filename, "wx+", 0o600)
        created = true
        const buffer = typeof content === "string" ? bytes(content) : content
        let offset = 0
        while (offset < buffer.length) {
          const written = writeFile(source, buffer, offset, buffer.length - offset, offset)
          if (!written) throw Object.assign(new Error("EIO"), { code: "EIO" })
          offset += written
        }
        extraStdio.push({ fd, source })
        source = undefined
      } finally {
        try {
          if (source !== undefined) closeFile(source)
        } finally {
          if (created) removeFile(filename)
        }
      }
    }
  } catch (error) {
    for (const { source } of extraStdio) closeFile(source)
    throw error
  }
  let closed = false
  const lifecycle = namespaceLifecycle()
  return {
    executable,
    args,
    env,
    cwd: root,
    extraStdio,
    pidNamespace: true,
    statusFd: 5,
    network,
    ...lifecycle,
    dispose: () => {
      if (!closed) {
        closed = true
        for (const { source } of extraStdio) closeFile(source)
      }
    },
  }
}
