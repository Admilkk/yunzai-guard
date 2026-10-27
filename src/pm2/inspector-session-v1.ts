import { ChildProcess } from "node:child_process"
import { integer, plain, sameNonce, currentDaemonGod, runtimeContext } from "./god-context.js"
import type { Pm2DaemonGod, Pm2DaemonContext, Pm2InspectorCloseOptions } from "./types.js"
import { ownRegistry, nativeCollection } from "./legacy-sidecar.js"
import { M } from "../shared/messages.js"

export const pm2InspectorSessionProtocol = 1

const inspectorCloseKey = Symbol.for("yunzai-guard.pm2-inspector-close.v1")
interface InspectorCloseRequest {
  child: ChildProcess
  nonce: string
  url: string
  closed: boolean
  dispose(): void
}
interface InspectorCloseRegistry {
  protocol: 1
  requests: Map<ChildProcess, InspectorCloseRequest>
}
/** 校验 Inspector 端点地址。 */
export function validateInspectorUrl(value: unknown, closeOnly = false): asserts value is string {
  if (typeof value !== "string" || value.length > 512) throw new Error(M.pm2.endpoint)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(M.pm2.endpoint)
  }
  if (
    url.protocol !== "ws:" ||
    !["127.0.0.1", "[::1]", "localhost", ...(closeOnly ? ["0.0.0.0", "[::]"] : [])].includes(
      url.hostname,
    ) ||
    !integer(Number(url.port), 1, 65535) ||
    url.pathname === "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(M.pm2.endpoint)
}

/** 读取 daemon 上的 Inspector 关闭登记表。 */
export function closeRegistryFor(god: Pm2DaemonGod): InspectorCloseRegistry | undefined {
  const registry = ownRegistry<InspectorCloseRegistry>(god, inspectorCloseKey)
  if (!registry) return undefined
  if (
    !registry ||
    registry.protocol !== 1 ||
    !nativeCollection(registry.requests, Map.prototype) ||
    [...registry.requests].some(
      ([child, request]) =>
        !(child instanceof ChildProcess) ||
        !request ||
        typeof request !== "object" ||
        request.child !== child ||
        typeof request.nonce !== "string" ||
        typeof request.url !== "string" ||
        typeof request.closed !== "boolean" ||
        typeof request.dispose !== "function",
    )
  )
    throw new Error(M.pm2.cleanupRegistry)
  return registry
}

/** 独立准备清理，使后续登记失败时仍能关闭本次端点。 */
export function preparePm2InspectorCloseWithGod(
  god: Pm2DaemonGod,
  options: Pm2InspectorCloseOptions,
  context: Pm2DaemonContext,
): {
  status: "prepared"
  daemonPid: number
  pmId: number
  pid: number
  nonce: string
  url: string
} {
  const url = options.ownInspectorUrl ?? options.url
  validateInspectorUrl(url, true)
  if (
    !integer(options.pmId, 0, 2147483647) ||
    !integer(options.pid, 2, 2147483647) ||
    options.expectedDaemonPid !== context.daemonPid ||
    typeof options.nonce !== "string" ||
    !/^[a-zA-Z0-9_-]{16,128}$/.test(options.nonce) ||
    (options.url !== undefined &&
      options.ownInspectorUrl !== undefined &&
      options.url !== options.ownInspectorUrl) ||
    !context.inspector ||
    typeof context.inspector.url !== "function" ||
    typeof context.inspector.close !== "function" ||
    context.inspector.url() !== url
  )
    throw new Error(M.pm2.cleanupIdentity)
  const child = god.clusters_db[String(options.pmId)]
  if (
    !(child instanceof ChildProcess) ||
    child.pid !== options.pid ||
    child.exitCode !== null ||
    child.signalCode !== null ||
    !child.connected
  )
    throw new Error(M.pm2.cleanupChild)
  let registry = closeRegistryFor(god)
  const existing = registry?.requests.get(child)
  if (existing && (existing.nonce !== options.nonce || existing.url !== url))
    throw new Error(M.pm2.cleanupBusy)
  if (!registry) {
    if (!Object.isExtensible(god)) throw new Error(M.pm2.godFrozen)
    registry = { protocol: 1, requests: new Map() }
    Object.defineProperty(god, inspectorCloseKey, { value: registry })
  }
  if (!existing) {
    const requests = registry.requests
    let settled = false
    const dispose = (): void => {
      clearTimeout(timer)
      child.removeListener("message", listener)
      child.removeListener("exit", dispose)
      if (requests.get(child) === request) requests.delete(child)
    }
    const request: InspectorCloseRequest = {
      child,
      nonce: options.nonce,
      url,
      closed: false,
      dispose,
    }
    const listener = (message: unknown): void => {
      if (
        settled ||
        !plain(message) ||
        message.type !== "yunzai-guard-pm2-inspector-close" ||
        !sameNonce(message.nonce, options.nonce) ||
        message.url !== url
      )
        return
      if (
        god.clusters_db[String(options.pmId)] !== child ||
        child.pid !== options.pid ||
        !child.connected ||
        context.inspector!.url() !== url
      )
        return
      settled = true
      dispose()
      try {
        // 客户端关闭 WebSocket 后，才通过普通子进程 IPC 执行。
        context.inspector!.close()
        if (context.inspector!.url() !== undefined) throw new Error(M.pm2.inspectorActive)
        request.closed = true
        child.send(
          {
            type: "yunzai-guard-pm2-inspector-closed",
            nonce: options.nonce,
            url,
            daemonPid: context.daemonPid,
            pmId: options.pmId,
            pid: options.pid,
          },
          () => {},
        )
      } catch {
        try {
          context.report?.({
            event: "pm2-inspector-cleanup-failed",
            pmId: options.pmId,
            pid: options.pid,
          })
        } catch {}
      }
    }
    const timer = setTimeout(dispose, 60000)
    timer.unref()
    requests.set(child, request)
    child.on("message", listener)
    child.once("exit", dispose)
  }
  return {
    status: "prepared",
    daemonPid: context.daemonPid,
    pmId: options.pmId,
    pid: options.pid,
    nonce: options.nonce,
    url,
  }
}

/** 在当前 daemon 中准备关闭 Inspector。 */
export function preparePm2InspectorClose(options: Pm2InspectorCloseOptions) {
  return preparePm2InspectorCloseWithGod(currentDaemonGod(options), options, runtimeContext())
}
