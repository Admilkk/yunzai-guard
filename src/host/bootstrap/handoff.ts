import { randomBytes, timingSafeEqual } from "node:crypto"
import { watchBootstrapExit, type BootstrapProcessIdentity } from "./exit-watch.js"
import { M } from "../../shared/messages.js"

interface BootstrapHandoffOptions {
  bootstrapPid: number
  redisPid: number | null
  timeout: number
  signal: AbortSignal
  bound?: (identities: readonly BootstrapProcessIdentity[]) => void
}

/** 必须收到父进程私有 IPC 提交，并确认两个原始进程均已退出。 */
export async function waitForBootstrapHandoff(
  options: BootstrapHandoffOptions,
): Promise<readonly BootstrapProcessIdentity[]> {
  if (!process.connected || !process.send || process.ppid !== options.bootstrapPid)
    throw new Error(M.host.handoffIpc)
  if (options.signal.aborted) throw new Error(M.host.handoffCancelled)
  const watch = await watchBootstrapExit(options.bootstrapPid, options.redisPid, options.timeout)
  const nonce = randomBytes(24).toString("hex")
  let timer: ReturnType<typeof setTimeout> | undefined
  let committed = false
  let rejectHandoff: (error: Error) => void = () => {}
  const message = (raw: unknown) => {
    if (!raw || typeof raw !== "object" || committed) return
    const value = raw as Record<string, unknown>
    if (
      value.type !== "bootstrap-handoff-commit" ||
      value.version !== 1 ||
      typeof value.nonce !== "string" ||
      !/^[a-f0-9]{48}$/.test(value.nonce) ||
      !timingSafeEqual(Buffer.from(value.nonce), Buffer.from(nonce))
    )
      return
    committed = true
    resolveCommit()
  }
  let resolveCommit: () => void = () => {}
  const disconnected = () => {
    if (!committed) rejectHandoff(new Error(M.host.handoffDisconnected))
  }
  const abort = () => rejectHandoff(new Error(M.host.handoffCancelled))
  try {
    const commit = new Promise<void>(resolve => {
      resolveCommit = resolve
    })
    const failed = new Promise<never>((_, reject) => (rejectHandoff = reject))
    // 立即观察任一失败，包括提交前的观察器失败。
    const completion = Promise.race([Promise.all([commit, watch.exited]), failed])
    void completion.catch(() => {})
    process.on("message", message)
    process.once("disconnect", disconnected)
    options.signal.addEventListener("abort", abort, { once: true })
    timer = setTimeout(() => rejectHandoff(new Error(M.host.handoffCommitTimeout)), options.timeout)
    if (options.signal.aborted) abort()
    else if (!process.connected) disconnected()
    else {
      options.bound?.(watch.identities)
      process.send({ type: "armed", version: 1, nonce }, error => {
        if (error) rejectHandoff(error)
      })
    }
    await completion
    if (options.signal.aborted) throw new Error(M.host.handoffCancelled)
    return watch.identities
  } finally {
    clearTimeout(timer)
    process.off("message", message)
    process.off("disconnect", disconnected)
    options.signal.removeEventListener("abort", abort)
    await watch.close()
  }
}
