import fs from "node:fs"
import path from "node:path"
import net from "node:net"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { M } from "../shared/messages.js"

const execute = promisify(execFile)
const timeoutMs = 1500

export class ProjectLockError extends Error {
  /** 创建带错误码的宿主锁错误。 */
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

interface ControlIdentity {
  token: string
  port: number
  hostPid: number
  projectId: string
}

export interface ProjectLockDependencies {
  listen?: (endpoint: string | number, server?: net.Server) => Promise<net.Server>
  processAlive?: (pid: number) => Promise<boolean> | boolean
  queryStatus?: (identity: ControlIdentity) => Promise<unknown>
  portListening?: (port: number) => Promise<boolean>
  portExcluded?: (port: number) => Promise<boolean>
  nonListeningConnections?: (port: number) => Promise<boolean>
}

export interface ProjectLock {
  kind: "named-pipe" | "tcp"
  endpoint: string | number
  legacyPort: number
  legacyPortExcluded: boolean
  legacyBridgeUnavailable: boolean
  legacyBridgeReason?: "excluded-port" | "non-listening-connections"
  servers: net.Server[]
  close(): Promise<void>
}

/** 校验项目标识格式。 */
function validProject(projectId: string): void {
  if (!/^[0-9a-f]{16}$/.test(projectId)) throw new Error(M.host.lockIdentity)
}

/** 由项目标识推算旧版控制端口。 */
export function legacyProjectPort(projectId: string): number {
  validProject(projectId)
  return 40000 + (parseInt(projectId.slice(0, 6), 16) % 20000)
}

/** 由项目标识生成 Windows 命名管道路径。 */
export function windowsProjectPipe(projectId: string): string {
  validProject(projectId)
  return `\\\\.\\pipe\\yunzai-guard-project-${projectId}`
}

/** 仅解析 netsh 的数字范围行，忽略本地化标题。 */
export function excludedPortRanges(output: string): Array<[number, number]> {
  if (output.length > 65536) throw new Error(M.host.excludedPortsTooLarge)
  return output.split(/\r?\n/).flatMap(line => {
    const match = /^\s*(\d{1,5})\s+(\d{1,5})(?:\s+\*)?\s*$/.exec(line)
    if (!match) return []
    const start = Number(match[1]),
      end = Number(match[2])
    if (start < 1 || end > 65535 || start > end) throw new Error(M.host.excludedPortRange)
    return [[start, end] as [number, number]]
  })
}

/** 判断端口是否在系统保留范围内（Windows netsh）。 */
async function portExcluded(port: number): Promise<boolean> {
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "netsh.exe")
  const { stdout } = await execute(
    executable,
    ["interface", "ipv4", "show", "excludedportrange", "protocol=tcp"],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 65536,
    },
  )
  return excludedPortRanges(stdout).some(([start, end]) => port >= start && port <= end)
}

/** 仅接受明确的 Bound 状态及已连接对端；监听状态和未知行均拒绝。 */
export function onlyNonListeningConnections(value: unknown): boolean {
  const rows = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : []
  if (!rows.length || rows.length > 128) return false
  const bound = new Set<number>(),
    connected = new Set<number>()
  for (const item of rows) {
    if (!item || typeof item !== "object") return false
    const row = item as Record<string, unknown>
    if (
      !Number.isSafeInteger(row.owner) ||
      Number(row.owner) <= 0 ||
      typeof row.remote !== "string"
    )
      return false
    if (row.state === "Bound" && row.remotePort === 0 && ["0.0.0.0", "::"].includes(row.remote))
      bound.add(Number(row.owner))
    else if (
      ["Established", "SynSent"].includes(String(row.state)) &&
      Number.isSafeInteger(row.remotePort) &&
      Number(row.remotePort) > 0 &&
      Number(row.remotePort) <= 65535 &&
      net.isIP(row.remote) &&
      !["0.0.0.0", "::"].includes(row.remote)
    )
      connected.add(Number(row.owner))
    else return false
  }
  return (
    bound.size > 0 &&
    connected.size > 0 &&
    [...bound].every(pid => connected.has(pid)) &&
    [...connected].every(pid => bound.has(pid))
  )
}

/** 判断端口上是否存在非监听状态的连接。 */
async function nonListeningConnections(port: number): Promise<boolean> {
  const executable = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  )
  const command = `$ErrorActionPreference='Stop'; @(Get-NetTCPConnection -ErrorAction Stop | Where-Object {$_.LocalPort -eq ${port}} | ForEach-Object {@{state=$_.State.ToString();owner=[int]$_.OwningProcess;remote=[string]$_.RemoteAddress;remotePort=[int]$_.RemotePort}}) | ConvertTo-Json -Compress`
  const { stdout } = await execute(
    executable,
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", windowsHide: true, timeout: 8000, maxBuffer: 65536 },
  )
  return onlyNonListeningConnections(stdout.trim() ? JSON.parse(stdout) : [])
}

/** 判断进程是否仍存活。 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

/** 向已有宿主查询状态，用于判断锁的持有者是否有效。 */
function queryStatus(identity: ControlIdentity): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: identity.port })
    let input = "",
      done = false
    const finish = (error?: Error, value?: unknown) => {
      if (done) return
      done = true
      socket.destroy()
      error ? reject(error) : resolve(value)
    }
    socket.setTimeout(timeoutMs, () => finish(new Error(M.host.previousTimeout)))
    socket.on("error", error => finish(error))
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ token: identity.token, command: "status" })}\n`),
    )
    socket.on("data", bytes => {
      input += bytes.toString("utf8")
      if (Buffer.byteLength(input) > 65536) return finish(new Error(M.host.previousTooLarge))
      if (!input.includes("\n")) return
      try {
        finish(undefined, JSON.parse(input.split("\n")[0]))
      } catch {
        finish(new Error(M.host.previousInvalid))
      }
    })
    socket.on("end", () => finish(new Error(M.host.previousClosed)))
  })
}

/** 读取并校验控制身份文件。 */
function readControl(controlPath: string, projectId: string): ControlIdentity | undefined {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(controlPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  const parent = path.dirname(path.resolve(controlPath))
  const canonical = fs.realpathSync.native(parent)
  const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 65536 ||
    normalize(parent) !== normalize(canonical)
  )
    throw new Error(M.host.previousFile)
  const value = JSON.parse(fs.readFileSync(controlPath, "utf8")) as Partial<ControlIdentity> | null
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.token !== "string" ||
    !/^[0-9a-f]{48}$/.test(value.token) ||
    !Number.isSafeInteger(value.port) ||
    value.port! < 1 ||
    value.port! > 65535 ||
    !Number.isSafeInteger(value.hostPid) ||
    value.hostPid! <= 1 ||
    value.projectId !== projectId
  )
    throw new Error(M.host.previousIdentity)
  return value as ControlIdentity
}

/** 旧宿主状态未确认时，不删除或覆盖其凭据。 */
export async function assertNoPreviousHost(
  controlPath: string,
  projectId: string,
  dependencies: ProjectLockDependencies = {},
): Promise<"absent" | "stale"> {
  validProject(projectId)
  try {
    const identity = readControl(controlPath, projectId)
    if (!identity) return "absent"
    let status: unknown
    try {
      status = await (dependencies.queryStatus ?? queryStatus)(identity)
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ECONNREFUSED" ||
        (await (dependencies.processAlive ?? processAlive)(identity.hostPid))
      )
        throw new Error(M.host.previousUncertain)
      return "stale"
    }
    if (
      !status ||
      typeof status !== "object" ||
      Array.isArray(status) ||
      (status as Partial<ControlIdentity>).hostPid !== identity.hostPid ||
      (status as Partial<ControlIdentity>).projectId !== projectId
    )
      throw new Error(M.host.previousMismatch)
    throw new ProjectLockError("PROJECT_ALREADY_RUNNING", M.host.projectOwned)
  } catch (error) {
    if (error instanceof ProjectLockError) throw error
    throw new ProjectLockError("PREVIOUS_HOST_UNCONFIRMED", (error as Error).message)
  }
}

/** 判断端口是否已被监听。 */
function portListening(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port })
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(M.host.legacyProbeTimeout)))
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", error => {
      socket.destroy()
      if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") resolve(false)
      else reject(error)
    })
  })
}

/** 在端点上监听，作为项目单例锁。 */
function listen(endpoint: string | number, existing?: net.Server): Promise<net.Server> {
  const server = existing ?? net.createServer(socket => socket.destroy())
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => {
      server.off("listening", started)
      reject(error)
    }
    const started = () => {
      server.off("error", failed)
      resolve(server)
    }
    server.once("error", failed)
    server.once("listening", started)
    server.listen(
      typeof endpoint === "number"
        ? { host: "127.0.0.1", port: endpoint, exclusive: true }
        : { path: endpoint, exclusive: true },
    )
  })
}

/** 新 Windows 宿主统一使用同一命名管道锁，与控制端口无关。 */
export async function acquireProjectLock(
  options: {
    projectId: string
    controlPath: string
    platform?: NodeJS.Platform
    legacyServer?: net.Server
  },
  dependencies: ProjectLockDependencies = {},
): Promise<ProjectLock> {
  const platform = options.platform ?? process.platform
  const legacyPort = legacyProjectPort(options.projectId)
  const endpoint = platform === "win32" ? windowsProjectPipe(options.projectId) : legacyPort
  const servers: net.Server[] = []
  const close = async () => {
    for (const server of [...servers].reverse())
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  }
  let legacyPortExcluded = false
  let legacyBridgeReason: ProjectLock["legacyBridgeReason"]
  try {
    // Linux 上残留的旧默认控制端点会占用同一 TCP 端口。
    // 绑定不处理请求的锁监听器前先探测端口；竞争仍由原子绑定裁决。
    if (platform !== "win32")
      await assertNoPreviousHost(options.controlPath, options.projectId, dependencies)
    servers.push(
      await (dependencies.listen ?? listen)(
        endpoint,
        platform === "win32" ? undefined : options.legacyServer,
      ),
    )
    if (platform === "win32")
      await assertNoPreviousHost(options.controlPath, options.projectId, dependencies)
    if (platform === "win32") {
      try {
        servers.push(await (dependencies.listen ?? listen)(legacyPort, options.legacyServer))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error
        // 自定义控制端口若等于被排除的旧端口，则无法使用。
        if (options.legacyServer) throw error
        if (await (dependencies.portListening ?? portListening)(legacyPort)) throw error
        legacyPortExcluded = await (dependencies.portExcluded ?? portExcluded)(legacyPort)
        if (legacyPortExcluded) legacyBridgeReason = "excluded-port"
        else if (
          await (dependencies.nonListeningConnections ?? nonListeningConnections)(legacyPort)
        )
          legacyBridgeReason = "non-listening-connections"
        else throw error
      }
    }
    return {
      kind: platform === "win32" ? "named-pipe" : "tcp",
      endpoint,
      legacyPort,
      legacyPortExcluded,
      legacyBridgeUnavailable: legacyBridgeReason !== undefined,
      legacyBridgeReason,
      servers,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
