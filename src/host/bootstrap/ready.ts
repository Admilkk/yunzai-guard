import type { CoreBot } from "../../shared/types.js"
import { M } from "../../shared/messages.js"

/** 等待核心发出就绪信号。 */
export function waitForBootstrapReady(
  bot: CoreBot,
  timeout: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      bot.off("online", check)
      signal?.removeEventListener("abort", abort)
      if (error) reject(error)
      else resolve()
    }
    const abort = () => finish(new Error(M.host.readyCancelled))
    const check = () => {
      try {
        const stat = bot.stat as { online?: unknown } | undefined
        if (stat?.online === 2) finish()
      } catch (error) {
        finish(error)
      }
    }
    if (signal?.aborted) {
      abort()
      return
    }
    timer = setTimeout(() => finish(new Error(M.host.coreTimeout)), timeout)
    signal?.addEventListener("abort", abort, { once: true })
    try {
      bot.on("online", check)
      // 订阅后复查状态，兼容已经就绪的核心。
      check()
    } catch (error) {
      finish(error)
    }
  })
}
