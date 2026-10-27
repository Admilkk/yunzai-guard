import { ChildProcess } from "node:child_process"
import { performance } from "node:perf_hooks"
import { describeMissingExitHook, resolveExitHook, type ExitHookSource } from "./exit-hooks.js"
import { M } from "../../shared/messages.js"

interface RedisClientSnapshot {
  process?: unknown
  save?: () => Promise<unknown>
}

export interface BootstrapExitPlan {
  /** 退出时仅允许向捕获的原始 ChildProcess 发送信号。 */
  readonly redisPid: number | null
  prepare(timeout: number): Promise<void>
  assertCurrent(): void
}

/** 原回调仍可能执行时，仅准备持久化，不提前关闭资源。 */
export function createBootstrapExitPlan(
  bot: ExitHookSource,
  redisClient: unknown,
  currentClient: () => unknown,
): BootstrapExitPlan {
  const client = redisClient as RedisClientSnapshot | undefined
  const originalProcess = client?.process
  const ownedRedis = originalProcess instanceof ChildProcess ? originalProcess : undefined
  const redisPid = ownedRedis?.pid ?? null

  // 此回调必须保持同步；接管宿主会独立确认旧服务实际退出，
  // 之后才启动替代核心。
  process.once("exit", () => {
    if (!ownedRedis || ownedRedis.exitCode !== null || ownedRedis.signalCode !== null) return
    try {
      ownedRedis.kill("SIGTERM")
    } catch {
      // 进程退出时无法等待恢复，只能操作已捕获的原始句柄。
    }
  })
  if (
    ownedRedis &&
    (typeof redisPid !== "number" || !Number.isSafeInteger(redisPid) || redisPid <= 1)
  )
    throw new Error(M.host.redisPid)

  const assertCurrent = () => {
    if (currentClient() !== redisClient) throw new Error(M.host.redisClientChanged)
    if (client?.process !== originalProcess) throw new Error(M.host.redisServiceChanged)
    if (ownedRedis && ownedRedis.pid !== redisPid) throw new Error(M.host.redisPidChanged)
  }
  let preparation: Promise<void> | undefined
  const prepare = async (timeout: number) => {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error(M.host.exitPrepareTimeoutValue)
    const deadline = performance.now() + timeout
    const remaining = (stage: string) => {
      const budget = deadline - performance.now()
      if (budget <= 0) throw new Error(M.host.stageTimeout(stage))
      return budget
    }
    const bounded = async (stage: string, operation: (budget: number) => Promise<unknown>) => {
      const budget = remaining(stage)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.resolve().then(() => operation(remaining(stage))),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(M.host.stageTimeout(stage))), budget)
          }),
        ])
        remaining(stage)
      } finally {
        clearTimeout(timer)
      }
    }

    assertCurrent()
    const exitHook = resolveExitHook(bot)
    if (exitHook) await bounded(M.host.stageExitHooks, budget => exitHook("restart", budget))
    else console.error(describeMissingExitHook())
    assertCurrent()
    if (ownedRedis) {
      if (typeof client?.save !== "function") throw new Error(M.host.redisNoPersistence)
      await bounded(M.host.stageRedisSave, () => client.save!())
    }
    assertCurrent()
  }

  return Object.freeze({
    redisPid,
    assertCurrent,
    /** 准备退出；计划只执行一次，不重复调用退出钩子。 */
    prepare(timeout: number) {
      return (preparation ??= prepare(timeout))
    },
  })
}
