import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { execFile } from "node:child_process"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { powershell } from "./platform.js"

/** 业务进程树的系统层采样；包含原生扩展发起、不经过 JS 入口的读写与连接。 */
export interface ProcessUsage {
  sampledAt: number
  processes: number
  /** 进程树累计读取字节，含文件、管道与套接字。 */
  readBytes: number
  /** 进程树累计写入字节，含文件、管道与套接字。 */
  writeBytes: number
  /** 已建立的非回环 TCP 连接远端，形如 `1.2.3.4:443`、`[2001:db8::1]:443`。 */
  remote: string[]
  /** 已建立的回环 TCP 连接数量，例如本机 Redis。 */
  loopback: number
  /** 进程树常驻内存字节。 */
  rssBytes: number
  /** 进程树累计 CPU 秒数（用户态加内核态）。 */
  cpuSeconds: number
}

const maxProcesses = 512
/** Linux 的 /proc 时钟频率与页大小；USER_HZ 固定为 100，常见页大小为 4KB。 */
const clockTicks = 100
const pageSize = 4096
const maxRemote = 256

/** 判断地址是否为回环地址。 */
export function isLoopback(address: string): boolean {
  const value = address.toLowerCase()
  return (
    value === "::1" ||
    value.startsWith("127.") ||
    value.startsWith("::ffff:127.") ||
    value === "0:0:0:0:0:0:0:1"
  )
}

/** 把地址与端口组合为远端标识，IPv6 加方括号。 */
export function endpoint(address: string, port: number): string {
  return net.isIPv6(address) ? `[${address}]:${port}` : `${address}:${port}`
}

/** 解码 /proc/net/tcp 中的十六进制地址（IPv4 为小端 32 位，IPv6 为 4 组小端 32 位）。 */
export function decodeProcAddress(hex: string): string | undefined {
  const word = (text: string) => {
    const bytes: number[] = []
    for (let index = 6; index >= 0; index -= 2)
      bytes.push(parseInt(text.slice(index, index + 2), 16))
    return bytes
  }
  if (hex.length === 8) return word(hex).join(".")
  if (hex.length !== 32) return undefined
  const bytes: number[] = []
  for (let index = 0; index < 32; index += 8) bytes.push(...word(hex.slice(index, index + 8)))
  const mapped =
    bytes.slice(0, 10).every(item => item === 0) && bytes[10] === 255 && bytes[11] === 255
  if (mapped) return `::ffff:${bytes.slice(12).join(".")}`
  const groups: string[] = []
  for (let index = 0; index < 16; index += 2)
    groups.push(((bytes[index]! << 8) | bytes[index + 1]!).toString(16))
  return groups.join(":").replace(/(^|:)0(:0)+(:|$)/, "::")
}

/** 解析 /proc/net/tcp(6) 文本，返回 inode 到已建立连接远端的映射。 */
export function parseProcTcp(text: string): Map<string, { address: string; port: number }> {
  const result = new Map<string, { address: string; port: number }>()
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10 || fields[3] !== "01") continue
    const [hex, portHex] = fields[2]!.split(":")
    const address = hex && decodeProcAddress(hex)
    if (!address || !portHex) continue
    result.set(fields[9]!, { address, port: parseInt(portHex, 16) })
  }
  return result
}

/** 读取文件，失败时返回 undefined（进程可能已退出或无权读取）。 */
function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

/** 从根进程出发，按 /proc/<pid>/stat 的父进程字段收集后代。 */
function linuxTree(root: number): number[] {
  const children = new Map<number, number[]>()
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue
    const stat = readText(`/proc/${name}/stat`)
    const close = stat?.lastIndexOf(")") ?? -1
    if (!stat || close < 0) continue
    const parent = Number(stat.slice(close + 2).split(" ")[1])
    const list = children.get(parent) ?? []
    list.push(Number(name))
    children.set(parent, list)
  }
  const tree = [root]
  for (let index = 0; index < tree.length && tree.length < maxProcesses; index++)
    tree.push(...(children.get(tree[index]!) ?? []))
  return tree.slice(0, maxProcesses)
}

/** Linux：读取 /proc 中的 I/O 计数与套接字 inode，再对照各网络命名空间的连接表。 */
function sampleLinux(root: number): ProcessUsage | undefined {
  if (!fs.existsSync(`/proc/${root}`)) return undefined
  const usage: ProcessUsage = {
    sampledAt: Date.now(),
    processes: 0,
    readBytes: 0,
    writeBytes: 0,
    remote: [],
    loopback: 0,
    rssBytes: 0,
    cpuSeconds: 0,
  }
  const sockets = new Set<string>()
  const namespaces = new Map<string, number>()
  for (const pid of linuxTree(root)) {
    const io = readText(`/proc/${pid}/io`)
    if (io === undefined && !fs.existsSync(`/proc/${pid}`)) continue
    usage.processes++
    const stat = readText(`/proc/${pid}/stat`)
    const close = stat?.lastIndexOf(")") ?? -1
    if (stat && close >= 0) {
      const fields = stat.slice(close + 2).split(" ")
      usage.cpuSeconds += ((Number(fields[11]) || 0) + (Number(fields[12]) || 0)) / clockTicks
      usage.rssBytes += (Number(fields[21]) || 0) * pageSize
    }
    usage.readBytes += Number(/^rchar:\s*(\d+)/m.exec(io ?? "")?.[1] ?? 0)
    usage.writeBytes += Number(/^wchar:\s*(\d+)/m.exec(io ?? "")?.[1] ?? 0)
    let owned = false
    try {
      for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
        const link = fs.readlinkSync(path.join(`/proc/${pid}/fd`, fd))
        const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1]
        if (inode) {
          sockets.add(inode)
          owned = true
        }
      }
    } catch {
      // 进程退出或无权读取 fd 目录时跳过。
    }
    if (!owned) continue
    try {
      const namespace = fs.readlinkSync(`/proc/${pid}/ns/net`)
      if (!namespaces.has(namespace)) namespaces.set(namespace, pid)
    } catch {
      // 无法确认命名空间时不读取其连接表。
    }
  }
  const remote = new Set<string>()
  for (const pid of namespaces.values())
    for (const table of ["tcp", "tcp6"]) {
      const text = readText(`/proc/${pid}/net/${table}`)
      if (!text) continue
      for (const [inode, peer] of parseProcTcp(text)) {
        if (!sockets.has(inode)) continue
        if (isLoopback(peer.address)) usage.loopback++
        else if (remote.size < maxRemote) remote.add(endpoint(peer.address, peer.port))
      }
    }
  usage.remote = [...remote].sort()
  return usage
}

/** Windows：一次 PowerShell 调用取得进程树、I/O 传输量与已建立的 TCP 连接。 */
async function sampleWindows(root: number): Promise<ProcessUsage | undefined> {
  const script = [
    "$ErrorActionPreference='Stop'",
    `$root=${root}`,
    "$all=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,ReadTransferCount,WriteTransferCount,WorkingSetSize,KernelModeTime,UserModeTime)",
    "if(-not ($all|Where-Object {$_.ProcessId -eq $root})){'null';exit 0}",
    "$set=@{};$set[[int]$root]=$true",
    "do{$added=$false;foreach($p in $all){if($set.Count -ge 512){break};if($set.ContainsKey([int]$p.ParentProcessId) -and -not $set.ContainsKey([int]$p.ProcessId) -and $p.ProcessId -ne $p.ParentProcessId){$set[[int]$p.ProcessId]=$true;$added=$true}}}while($added)",
    "$tree=@($all|Where-Object {$set.ContainsKey([int]$_.ProcessId)})",
    "$conn=@(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue|Where-Object {$set.ContainsKey([int]$_.OwningProcess)}|ForEach-Object {[string]$_.RemoteAddress+'|'+[string]$_.RemotePort})",
    "[pscustomobject]@{processes=$tree.Count;read=[double](($tree|Measure-Object ReadTransferCount -Sum).Sum);write=[double](($tree|Measure-Object WriteTransferCount -Sum).Sum);rss=[double](($tree|Measure-Object WorkingSetSize -Sum).Sum);cpu=[double](($tree|Measure-Object KernelModeTime -Sum).Sum)+[double](($tree|Measure-Object UserModeTime -Sum).Sum);connections=$conn}|ConvertTo-Json -Compress",
  ].join(";")
  const output = await powershell(script, 20000)
  const value = JSON.parse(output) as {
    processes?: unknown
    read?: unknown
    write?: unknown
    rss?: unknown
    cpu?: unknown
    connections?: unknown
  } | null
  if (!value) return undefined
  const usage: ProcessUsage = {
    sampledAt: Date.now(),
    processes: Number(value.processes) || 0,
    readBytes: Number(value.read) || 0,
    writeBytes: Number(value.write) || 0,
    remote: [],
    loopback: 0,
    rssBytes: Number(value.rss) || 0,
    // Win32_Process 的 CPU 时间单位为 100 纳秒。
    cpuSeconds: (Number(value.cpu) || 0) / 1e7,
  }
  const list = Array.isArray(value.connections)
    ? value.connections
    : typeof value.connections === "string"
      ? [value.connections]
      : []
  const remote = new Set<string>()
  for (const item of list) {
    const [address, port] = String(item).split("|")
    if (!address || !net.isIP(address) || !/^\d+$/.test(port ?? "")) continue
    if (isLoopback(address)) usage.loopback++
    else if (remote.size < maxRemote) remote.add(endpoint(address, Number(port)))
  }
  usage.remote = [...remote].sort()
  return usage
}

/** 执行系统命令；失败或退出码非零时返回空串。 */
function run(file: string, args: string[]): Promise<string> {
  return new Promise(resolve =>
    execFile(file, args, { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
      resolve(error && !stdout ? "" : String(stdout)),
    ),
  )
}

/** 解析 ps 的累计 CPU 时间，形如 `1:02.50` 或 `1-02:03:04`。 */
export function cpuTime(value: string | undefined): number {
  if (!value) return 0
  const [days, rest] = value.includes("-") ? value.split("-") : ["0", value]
  const parts = (rest ?? "").split(":").map(Number)
  if (parts.some(Number.isNaN)) return 0
  return parts.reduce((total, part) => total * 60 + part, 0) + (Number(days) || 0) * 86400
}

/** 拆分 lsof 输出中的“地址:端口”，IPv6 带方括号。 */
function splitEndpoint(value: string): { address: string; port: number } | undefined {
  const at = value.lastIndexOf(":")
  if (at < 0) return undefined
  const port = Number(value.slice(at + 1))
  const address = value.slice(0, at).replace(/^\[|\]$/g, "")
  return Number.isInteger(port) && address ? { address, port } : undefined
}

/**
 * macOS：用系统自带的 ps 找出进程树，lsof 读取已建立的 TCP 连接。
 * macOS 不向普通用户提供逐进程累计读写字节，这两项记为 0。
 */
async function sampleDarwin(root: number): Promise<ProcessUsage | undefined> {
  const children = new Map<number, number[]>()
  const meters = new Map<number, { rss: number; cpu: number }>()
  let found = false
  for (const line of (await run("/bin/ps", ["-A", "-o", "pid=,ppid=,rss=,time="])).split("\n")) {
    const [pid, parent, rss, time] = line.trim().split(/\s+/)
    const id = Number(pid)
    const parentId = Number(parent)
    if (!id || Number.isNaN(parentId)) continue
    meters.set(id, { rss: (Number(rss) || 0) * 1024, cpu: cpuTime(time) })
    if (id === root) found = true
    const list = children.get(parentId) ?? []
    list.push(id)
    children.set(parentId, list)
  }
  if (!found) return undefined
  const tree = [root]
  for (let index = 0; index < tree.length && tree.length < maxProcesses; index++)
    tree.push(...(children.get(tree[index]!) ?? []))
  const usage: ProcessUsage = {
    sampledAt: Date.now(),
    processes: tree.length,
    readBytes: 0,
    writeBytes: 0,
    remote: [],
    loopback: 0,
    rssBytes: tree.reduce((sum, pid) => sum + (meters.get(pid)?.rss ?? 0), 0),
    cpuSeconds: tree.reduce((sum, pid) => sum + (meters.get(pid)?.cpu ?? 0), 0),
  }
  const output = await run("/usr/sbin/lsof", [
    "-nP",
    "-a",
    "-p",
    tree.join(","),
    "-iTCP",
    "-sTCP:ESTABLISHED",
    "-Fn",
  ])
  const remote = new Set<string>()
  for (const line of output.split("\n")) {
    if (!line.startsWith("n") || !line.includes("->")) continue
    const peer = splitEndpoint(line.slice(line.indexOf("->") + 2).trim())
    if (!peer) continue
    if (isLoopback(peer.address)) usage.loopback++
    else if (remote.size < maxRemote) remote.add(endpoint(peer.address, peer.port))
  }
  usage.remote = [...remote].sort()
  return usage
}

/** 采样进程树；进程已退出或平台不支持时返回 undefined。 */
export async function sampleUsage(root: number): Promise<ProcessUsage | undefined> {
  if (!Number.isSafeInteger(root) || root <= 1) return undefined
  if (process.platform === "linux") return sampleLinux(root)
  if (process.platform === "win32") return sampleWindows(root)
  if (process.platform === "darwin") return sampleDarwin(root)
  return undefined
}

/** 定期采样一个业务进程树，并对新出现的外部连接回调一次。 */
export class UsageWatch {
  readonly #root: number
  readonly #onConnection: (remote: string, usage: ProcessUsage) => void
  readonly #onSample: ((usage: ProcessUsage) => void) | undefined
  readonly #seen = new Set<string>()
  #timer: ReturnType<typeof setInterval> | undefined
  #running = false
  #latest: ProcessUsage | undefined

  /** 创建采样器；回调异常不影响后续采样。 */
  constructor(
    root: number,
    onConnection: (remote: string, usage: ProcessUsage) => void,
    onSample?: (usage: ProcessUsage) => void,
  ) {
    this.#root = root
    this.#onConnection = onConnection
    this.#onSample = onSample
  }

  /** 最近一次成功的采样。 */
  get latest(): ProcessUsage | undefined {
    return this.#latest
  }

  /** 开始定期采样；Windows 依赖 PowerShell，间隔更长。 */
  start(intervalMs = process.platform === "linux" ? 10000 : 30000): void {
    if (this.#timer) return
    void this.sample()
    this.#timer = setInterval(() => void this.sample(), intervalMs)
    this.#timer.unref()
  }

  /** 立即采样一次；上一次未完成时跳过。 */
  async sample(): Promise<ProcessUsage | undefined> {
    if (this.#running) return this.#latest
    this.#running = true
    try {
      const usage = await sampleUsage(this.#root)
      if (!usage) return this.#latest
      this.#latest = usage
      try {
        this.#onSample?.(usage)
      } catch {
        // 历史记录失败不影响采样。
      }
      for (const remote of usage.remote) {
        if (this.#seen.has(remote) || this.#seen.size >= maxRemote) continue
        this.#seen.add(remote)
        try {
          this.#onConnection(remote, usage)
        } catch {
          // 记录失败不影响采样。
        }
      }
      return usage
    } catch {
      return this.#latest
    } finally {
      this.#running = false
    }
  }

  /** 停止采样。 */
  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
  }
}

export interface ResourcePoint {
  time: number
  processes: number
  rssBytes: number
  /** 采样间隔内的 CPU 占用，单位为核（1 = 一个核心满载）。 */
  cpu: number
  readBytesPerSecond: number
  writeBytesPerSecond: number
  connections: number
  /** 宿主进程常驻内存。 */
  hostRssBytes: number
  /** 宿主事件循环延迟 p99，毫秒。 */
  hostLagMs: number
}

const maxPoints = 360

/** 业务进程树的资源历史：由累计计数换算出速率，保留最近一段时间的曲线。 */
export class ResourceHistory {
  readonly #points: ResourcePoint[] = []
  #previous: ProcessUsage | undefined
  readonly #hostLag = monitorEventLoopDelay({ resolution: 20 })

  /** 开始统计宿主事件循环延迟。 */
  constructor() {
    this.#hostLag.enable()
  }

  /** 记录一次采样；业务进程重启后累计值回退时，速率记为 0。 */
  push(usage: ProcessUsage): void {
    const previous = this.#previous
    this.#previous = usage
    const seconds = previous ? (usage.sampledAt - previous.sampledAt) / 1000 : 0
    const rate = (now: number, before: number | undefined): number =>
      seconds > 0 && before !== undefined && now >= before ? (now - before) / seconds : 0
    const lag = this.#hostLag.percentile(99) / 1e6
    this.#hostLag.reset()
    this.#points.push({
      time: usage.sampledAt,
      processes: usage.processes,
      rssBytes: usage.rssBytes,
      cpu: Math.round(rate(usage.cpuSeconds, previous?.cpuSeconds) * 1000) / 1000,
      readBytesPerSecond: Math.round(rate(usage.readBytes, previous?.readBytes)),
      writeBytesPerSecond: Math.round(rate(usage.writeBytes, previous?.writeBytes)),
      connections: usage.remote.length + usage.loopback,
      hostRssBytes: process.memoryUsage().rss,
      hostLagMs: Number.isFinite(lag) ? Math.round(lag * 10) / 10 : 0,
    })
    if (this.#points.length > maxPoints) this.#points.shift()
  }

  /** 业务进程重建后断开速率计算。 */
  restart(): void {
    this.#previous = undefined
  }

  /** 历史采样点，旧的在前。 */
  points(): ResourcePoint[] {
    return [...this.#points]
  }
}
