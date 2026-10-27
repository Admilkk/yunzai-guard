import { performance } from "node:perf_hooks"
import type { CoreBot } from "../../shared/types.js"
import { M } from "../../shared/messages.js"

export type ExitHookRunner = (reason: string, budget: number) => Promise<unknown>
export type ExitHookSource = {
  exitEvent?: CoreBot["exitEvent"]
  rawListeners?: (event: string) => Function[]
}

/** 取得核心的退出钩子，不存在时返回 undefined。 */
export function resolveExitHook(bot: ExitHookSource): ExitHookRunner | undefined {
  const handler = bot.exitEvent
  if (typeof handler === "function") return (reason, budget) => handler.call(bot, reason, budget)
  const rawListeners = bot.rawListeners
  if (typeof rawListeners !== "function") return undefined
  let preparation: Promise<unknown> | undefined
  return (reason, budget) =>
    (preparation ??= (async () => {
      if (!Number.isFinite(budget) || budget <= 0) throw new Error(M.host.exitHooksTimeoutValue)
      const deadline = performance.now() + budget
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // 调用原始包装器，保留 once 的移除语义；不能调用会结束进程的 Bot.exit。
        const tasks = rawListeners
          .call(bot, "exit")
          .map(listener => Promise.resolve().then(() => listener.call(bot, reason)))
        await Promise.race([
          Promise.allSettled(tasks).then(results => {
            if (performance.now() >= deadline) throw new Error(M.host.exitHooksTimeout)
            const failures = results
              .filter(result => result.status === "rejected")
              .map(result => result.reason)
            if (failures.length) throw new AggregateError(failures, M.host.exitHooksFailed)
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(M.host.exitHooksTimeout)), budget)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    })())
}

/** 返回缺少退出钩子时的说明。 */
export function describeMissingExitHook(): string {
  return M.host.noExitHook
}
