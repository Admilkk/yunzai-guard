import net from "node:net"
import { fileURLToPath } from "node:url"
import type dgram from "node:dgram"
import { stripGuardExecArgv } from "../runtime/launch.js"

export interface Description {
  kind: "network" | "listen" | "process" | "filesystem" | "native"
  operation: string
  target: string
  auditTarget?: string
  details?: Record<string, unknown>
}
const rawURL = URL
const requestClass = globalThis.Request

/** 普通 fork 子进程不是宿主 worker，不能继承其握手预加载器。 */
export function prepareFork(args: unknown[]): unknown[] {
  const optionsAt = Array.isArray(args[1]) || (args[1] == null && args.length >= 3) ? 2 : 1
  const options = args[optionsAt]
  if (
    options !== undefined &&
    options !== null &&
    (typeof options !== "object" || Array.isArray(options))
  )
    return args // 无效参数交给 Node 原生校验器处理。
  const existing = options as Record<string, unknown> | undefined | null
  const inherited = existing?.execArgv === undefined ? process.execArgv : existing.execArgv
  if (!Array.isArray(inherited) || !inherited.every(item => typeof item === "string")) return args
  const filtered = stripGuardExecArgv(inherited)
  if (filtered.length === inherited.length) return args
  const prepared = [...args]
  prepared[optionsAt] = { ...existing, execArgv: filtered }
  return prepared
}

/** 返回非空字符串，否则返回默认值。 */
function text(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value.length ? value : fallback
}

/** 去掉控制字符并截断到 512 字符。 */
export function cleanTarget(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 512)
}

/** 清洗主机名，含非法字符时返回 invalid-host。 */
function networkHost(value: string): string {
  return /[\s/@?#\x00-\x1f]/.test(value) ? "invalid-host" : cleanTarget(value)
}

/** 规范化端口，无效时返回 default。 */
function networkPort(value: unknown): string {
  return (typeof value === "number" && Number.isInteger(value)) ||
    (typeof value === "string" && /^\d+$/.test(value))
    ? String(value).slice(0, 8)
    : "default"
}

/** 匹配与审计均省略 URL 凭据、查询参数及片段。 */
function urlTarget(input: string | URL, protocol: string): string {
  try {
    const url = new rawURL(input.toString(), `${protocol}//localhost`)
    return cleanTarget(`${url.protocol}//${url.host}${url.pathname}`)
  } catch {
    return `${protocol}//unresolved`
  }
}

/** 描述 http/https 请求的目标与方法。 */
export function describeRequest(operation: string, args: unknown[], protocol: string): Description {
  const first = args[0]
  let options: Record<string, unknown> = {}
  let url: URL | undefined
  if (typeof first === "string" || first instanceof rawURL) {
    try {
      url = new rawURL(first)
    } catch {
      // 策略评估后，保留原 API 对无效输入的处理行为。
    }
    if (args[1] && typeof args[1] === "object") options = args[1] as Record<string, unknown>
  } else if (first && typeof first === "object") options = first as Record<string, unknown>
  if (options.socketPath)
    return { kind: "network", operation, target: "unix:socket", details: { transport: "unix" } }
  const scheme = text(options.protocol, url?.protocol ?? protocol)
  let host = text(options.hostname, text(options.host, url?.hostname ?? "localhost"))
  if (host.includes(":") && !host.startsWith("[") && net.isIP(host) === 6) host = `[${host}]`
  const port = options.port ?? url?.port
  const pathname = text(options.path, url ? `${url.pathname}${url.search}` : "/")
  const target = urlTarget(
    `${scheme}//${host}${port ? `:${String(port)}` : ""}${pathname}`,
    protocol,
  )
  return {
    kind: "network",
    operation,
    target,
    details: { method: cleanTarget(text(options.method, "GET").toUpperCase()).slice(0, 32) },
  }
}

/** 描述套接字连接目标。 */
export function describeSocket(operation: string, args: unknown[], protocol: string): Description {
  const normalized = Array.isArray(args[0]) ? (args[0] as unknown[]) : args
  const first = normalized[0]
  let host = "localhost"
  let port: unknown
  if (first && typeof first === "object") {
    const options = first as Record<string, unknown>
    if (options.path) return { kind: "network", operation, target: "unix:socket" }
    host = text(options.host, text(options.hostname, "localhost"))
    port = options.port
    if (options.socket && !port)
      return { kind: "network", operation, target: `${protocol}existing-socket` }
  } else if (typeof first === "string" && !/^\d+$/.test(first))
    return { kind: "network", operation, target: "unix:socket" }
  else {
    port = first
    host = text(normalized[1], "localhost")
  }
  if (net.isIP(host) === 6) host = `[${host}]`
  return {
    kind: "network",
    operation,
    target: `${protocol}${networkHost(host)}:${networkPort(port)}`,
  }
}

/** 描述 UDP 发送目标。 */
export function describeDatagram(socket: dgram.Socket, args: unknown[]): Description {
  let destination: { address?: string; port?: number } | undefined
  try {
    destination = socket.remoteAddress()
  } catch {
    // 未连接的 socket 在每次 send 调用中指定目标。
  }
  if (!destination) {
    const offsetStyle =
      typeof args[1] === "number" && typeof args[2] === "number" && typeof args[3] === "number"
    const at = offsetStyle ? 3 : 1
    destination = {
      port: typeof args[at] === "number" ? args[at] : undefined,
      address: text(args[at + 1], "localhost"),
    }
  }
  const host = destination.address ?? "localhost"
  return {
    kind: "network",
    operation: "udp.send",
    target: `udp://${networkHost(net.isIP(host) === 6 ? `[${host}]` : host)}:${networkPort(destination.port)}`,
  }
}

/** 描述命令执行；shell 命令只保留首个程序名。 */
export function describeCommand(operation: string, args: unknown[]): Description {
  const executable = text(args[0])
  const shellCommand = operation === "exec" || operation === "execSync"
  // 完整 shell 命令仅供内存匹配器使用，不输出或持久化。
  const head = shellCommand
    ? executable.match(/^(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s;&|`$<>]+))/)
    : undefined
  const candidate = head?.[1] ?? head?.[2] ?? head?.[3]
  const auditTarget = shellCommand
    ? candidate && !candidate.includes("=")
      ? candidate
      : "shell-command"
    : executable
  const options = args.find(
    (item, i) => i > 0 && item !== null && typeof item === "object" && !Array.isArray(item),
  ) as Record<string, unknown> | undefined
  return {
    kind: "process",
    operation,
    target: executable,
    auditTarget: cleanTarget(auditTarget),
    details: {
      argumentCount: Array.isArray(args[1]) ? args[1].length : undefined,
      shell: shellCommand || Boolean(options?.shell),
      argumentsRedacted: true,
      ...(operation === "fork"
        ? {
            childMonitoring: "creation-only",
            inheritedGuardPreloadRemoved: prepareFork(args) !== args,
          }
        : {}),
    },
  }
}

/** 描述 fetch 请求的目标与方法。 */
export function describeFetch(args: unknown[]): Description {
  const input = args[0]
  const value =
    requestClass && input instanceof requestClass
      ? input.url
      : typeof input === "string" || input instanceof rawURL
        ? input
        : "unknown"
  const options = args[1] as RequestInit | undefined
  return {
    kind: "network",
    operation: "fetch",
    target: urlTarget(value, "https:"),
    details: {
      method: cleanTarget(
        options?.method ?? (requestClass && input instanceof requestClass ? input.method : "GET"),
      ).slice(0, 32),
    },
  }
}

/** 监听端口同样是网络暴露面；只记录地址与端口，不记录回调。 */
export function describeListen(operation: string, args: unknown[], protocol: string): Description {
  const listen = (description: Description): Description => ({ ...description, kind: "listen" })
  const first = args[0]
  if (first && typeof first === "object") {
    const options = first as Record<string, unknown>
    if (options.path) return { kind: "listen", operation, target: "unix:socket" }
    if ("fd" in options || "_handle" in options)
      return { kind: "listen", operation, target: `${protocol}existing-handle` }
    return listen(
      describeSocket(
        operation,
        [{ host: options.host ?? "0.0.0.0", port: options.port }],
        protocol,
      ),
    )
  }
  if (typeof first === "string" && !/^\d+$/.test(first))
    return { kind: "listen", operation, target: "unix:socket" }
  const host = typeof args[1] === "string" ? args[1] : "0.0.0.0"
  return listen(describeSocket(operation, [first, host], protocol))
}

/** 直接 DNS 查询；net/http 内部解析经 dns.lookup，不在此重复记录。 */
export function describeDns(operation: string, args: unknown[]): Description {
  const host = text(args[0], "invalid-host")
  return {
    kind: "network",
    operation,
    target: `dns://${networkHost(host)}`,
    details: typeof args[1] === "string" ? { record: cleanTarget(args[1]).slice(0, 16) } : {},
  }
}

/** 描述以 URL 为首参的网络连接。 */
export function describeUrl(operation: string, args: unknown[], protocol: string): Description {
  const input = args[0]
  const value = typeof input === "string" || input instanceof rawURL ? input : "unknown"
  return { kind: "network", operation, target: urlTarget(value, protocol) }
}

/** 文件目标只保留路径文本；句柄、fd 等非路径输入返回 undefined。 */
export function filePath(value: unknown): string | undefined {
  try {
    if (typeof value === "string") return cleanTarget(plainPath(value))
    if (Buffer.isBuffer(value)) return cleanTarget(plainPath(value.toString("utf8")))
    if (value instanceof rawURL && value.protocol === "file:")
      return cleanTarget(fileURLToPath(value))
  } catch {
    // 无效路径交给 fs 自身报错。
  }
  return undefined
}

/** 去掉 Windows 命名空间前缀（`\\?\`、`\\?\UNC\`），便于阅读和按普通路径写规则。 */
function plainPath(value: string): string {
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`
  if (value.startsWith("\\\\?\\")) return value.slice(4)
  return value
}

/** 描述一次文件访问。 */
export function describeFile(
  operation: string,
  target: string,
  write: boolean,
  source?: string,
): Description {
  return {
    kind: "filesystem",
    operation,
    target,
    details: { access: write ? "write" : "read", ...(source ? { source } : {}) },
  }
}

/** 描述原生扩展加载。 */
export function describeNative(args: unknown[]): Description {
  return {
    kind: "native",
    operation: "native.load",
    target: filePath(args[1]) ?? "unknown",
  }
}
