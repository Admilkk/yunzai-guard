import fs from "node:fs"
import net from "node:net"
import path from "node:path"
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
}

const maxProcesses = 512
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
  }
  const sockets = new Set<string>()
  const namespaces = new Map<string, number>()
  for (const pid of linuxTree(root)) {
    const io = readText(`/proc/${pid}/io`)
    if (io === undefined && !fs.existsSync(`/proc/${pid}`)) continue
    usage.processes++
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
    "$all=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,ReadTransferCount,WriteTransferCount)",
    "if(-not ($all|Where-Object {$_.ProcessId -eq $root})){'null';exit 0}",
    "$set=@{};$set[[int]$root]=$true",
    "do{$added=$false;foreach($p in $all){if($set.Count -ge 512){break};if($set.ContainsKey([int]$p.ParentProcessId) -and -not $set.ContainsKey([int]$p.ProcessId) -and $p.ProcessId -ne $p.ParentProcessId){$set[[int]$p.ProcessId]=$true;$added=$true}}}while($added)",
    "$tree=@($all|Where-Object {$set.ContainsKey([int]$_.ProcessId)})",
    "$conn=@(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue|Where-Object {$set.ContainsKey([int]$_.OwningProcess)}|ForEach-Object {[string]$_.RemoteAddress+'|'+[string]$_.RemotePort})",
    "[pscustomobject]@{processes=$tree.Count;read=[double](($tree|Measure-Object ReadTransferCount -Sum).Sum);write=[double](($tree|Measure-Object WriteTransferCount -Sum).Sum);connections=$conn}|ConvertTo-Json -Compress",
  ].join(";")
  const output = await powershell(script, 20000)
  const value = JSON.parse(output) as {
    processes?: unknown
    read?: unknown
    write?: unknown
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

/** 采样进程树；进程已退出或平台不支持时返回 undefined。 */
export async function sampleUsage(root: number): Promise<ProcessUsage | undefined> {
  if (!Number.isSafeInteger(root) || root <= 1) return undefined
  if (process.platform === "linux") return sampleLinux(root)
  if (process.platform === "win32") return sampleWindows(root)
  return undefined
}

/** 定期采样一个业务进程树，并对新出现的外部连接回调一次。 */
export class UsageWatch {
  readonly #root: number
  readonly #onConnection: (remote: string, usage: ProcessUsage) => void
  readonly #seen = new Set<string>()
  #timer: ReturnType<typeof setInterval> | undefined
  #running = false
  #latest: ProcessUsage | undefined

  /** 创建采样器；回调异常不影响后续采样。 */
  constructor(root: number, onConnection: (remote: string, usage: ProcessUsage) => void) {
    this.#root = root
    this.#onConnection = onConnection
  }

  /** 最近一次成功的采样。 */
  get latest(): ProcessUsage | undefined {
    return this.#latest
  }

  /** 开始定期采样；Windows 依赖 PowerShell，间隔更长。 */
  start(intervalMs = process.platform === "win32" ? 30000 : 10000): void {
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
