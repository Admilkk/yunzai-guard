import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { contextKey, stateDir } from "../shared/identity.js"
import { loadSettings } from "../config/index.js"
import type { GuardContext, GuardSettings } from "../shared/types.js"
import { registerCurrentPm2Application } from "../pm2/auto.js"
import { inspectorDeadline } from "../pm2/inspector.js"
import { waitForBootstrapReady } from "../host/bootstrap/ready.js"
import { createBootstrapExitPlan } from "../host/bootstrap/exit-plan.js"
import { prepareNode } from "../dependencies/node.js"
import { M } from "../shared/messages.js"

/** 读取核心当前的 Redis 客户端。 */
const originalRedisClient = () => (globalThis as typeof globalThis & { redis?: unknown }).redis
const bootstrapStarted = new WeakSet<object>()

/** 发送交接消息后退出当前进程。 */
function commitAndExit(send: (callback: (error: Error | null) => void) => void): Promise<never> {
  return new Promise((_, reject) => {
    send(error => {
      if (error) reject(error)
      else process.exit(0)
    })
  })
}

export class YunzaiGuard extends plugin {
  /** 以最高优先级注册为 Yunzai 插件。 */
  constructor() {
    super({
      name: "Yunzai Guard",
      event: "message",
      priority: -1000000,
      rule: [
        { reg: "^#?guard(强制)?更新$", fnc: "update", permission: "master" },
        { reg: "^#?guard(回滚|还原)$", fnc: "rollback", permission: "master" },
      ],
    })
  }

  /** 把消息交给独立插件沙箱分派，已处理时拦截后续插件。 */
  async accept(event: Record<string, unknown>): Promise<"return" | false> {
    const context = (globalThis as unknown as Record<symbol, GuardContext | undefined>)[contextKey]
    return (await context?.sandboxDispatch?.(event)) ? "return" : false
  }

  /** 主人的 #guard更新 / #guard强制更新：转交宿主执行，结果由宿主通知主人。 */
  async update(): Promise<boolean> {
    const context = (globalThis as unknown as Record<symbol, GuardContext | undefined>)[contextKey]
    if (!context?.requestUpdate) {
      await this.reply(M.entry.updateUnavailable)
      return true
    }
    const force = Boolean(this.e?.msg?.includes("强制"))
    context.requestUpdate(force)
    await this.reply(force ? M.entry.updateForced : M.entry.updateRequested)
    return true
  }

  /** 主人的 #guard回滚：还原到上一版本，结果由宿主通知主人。 */
  async rollback(): Promise<boolean> {
    const context = (globalThis as unknown as Record<symbol, GuardContext | undefined>)[contextKey]
    if (!context?.requestRollback) {
      await this.reply(M.entry.updateUnavailable)
      return true
    }
    context.requestRollback()
    await this.reply(M.entry.rollbackRequested)
    return true
  }

  /** 插件初始化：检查平台与配置，并在核心就绪后交接给受管宿主。 */
  async init(): Promise<string | undefined> {
    const context = (globalThis as unknown as Record<symbol, GuardContext | undefined>)[contextKey]
    if (context) return
    const managedByPm2 =
      process.env.pm_id !== undefined ||
      (process.env.PM2_HOME !== undefined && process.env.NODE_APP_INSTANCE !== undefined)
    if (managedByPm2 && !process.connected) {
      logger.error(M.entry.pm2NoIpc)
      process.exit(78)
    }
    // TRSS 官方 Docker 脚本与 node . daemon 以 node . start 启动（external），外部管理器跟踪这个进程本身。
    const external = global.start_type === "external" && !managedByPm2
    if (external && (process.platform === "win32" || typeof process.execve !== "function")) {
      logger.error(M.entry.externalUnsupported)
      process.exit(78)
    }
    if (global.start_type !== "internal" && !managedByPm2 && !external) {
      logger.error(M.entry.unmanagedEntry)
      process.exit(78)
    }
    if (bootstrapStarted.has(Bot)) return
    let settings: GuardSettings
    try {
      settings = loadSettings(stateDir)
    } catch (error) {
      // 核心会捕获插件初始化异常；仅抛错会留下未受保护的机器人。
      console.error(M.entry.invalidSettings, (error as Error).message)
      process.exit(1)
    }
    bootstrapStarted.add(Bot)
    logger.info(M.entry.waiting)
    // 核心等待 init 完成，因此不能在此等待上线事件。
    void (
      external ? this.replaceInPlace(settings) : this.takeOverWhenReady(settings, managedByPm2)
    ).catch(error => {
      console.error(M.entry.coldFailed, (error as Error).message)
      process.exit(managedByPm2 ? 78 : 1)
    })
  }

  /**
   * 外部托管时原地接管：核心就绪后释放原进程的资源，再用 execve 把本进程替换成 Guard 宿主。
   * PID 不变，Docker 的 1 号进程与 node . daemon 的子进程关系都保持原样，与 TRSS 自身的重启方式一致。
   */
  private async replaceInPlace(settings: GuardSettings): Promise<void> {
    const exitPlan = createBootstrapExitPlan(Bot, originalRedisClient(), originalRedisClient)
    await waitForBootstrapReady(Bot, settings.startupTimeout, new AbortController().signal)
    await exitPlan.prepare(settings.shutdownTimeout)
    exitPlan.assertCurrent()
    const env: NodeJS.ProcessEnv = { ...process.env, YUNZAI_GUARD_EXTERNAL: "1" }
    delete env.NODE_OPTIONS
    logger.info(M.entry.replacing)
    process.execve!(
      process.execPath,
      [process.execPath, fileURLToPath(new URL("../launcher.js", import.meta.url))],
      env,
    )
  }

  /** 核心就绪后准备运行时并交接；下载在交接前完成，不调整已有 PM2 daemon。 */
  private async takeOverWhenReady(settings: GuardSettings, managedByPm2: boolean): Promise<void> {
    const hostExecutable = managedByPm2
      ? process.execPath
      : await prepareNode(fileURLToPath(new URL("../../", import.meta.url)))
    const exitPlan = createBootstrapExitPlan(Bot, originalRedisClient(), originalRedisClient)
    const readiness = new AbortController()
    let exiting = false
    let bootstrapTimer: ReturnType<typeof setTimeout> | undefined
    let registrationPending: ReturnType<typeof registerCurrentPm2Application> | undefined
    if (managedByPm2)
      process.on("message", message => {
        if (message !== "shutdown" || exiting) return
        exiting = true
        readiness.abort()
        clearTimeout(bootstrapTimer)
        void (async () => {
          const registration = await registrationPending
          await exitPlan.prepare(settings.shutdownTimeout)
          exitPlan.assertCurrent()
          if (registration?.requiresHandoff && registration.nonce)
            await commitAndExit(callback =>
              process.send!(
                { type: "yunzai-guard-pm2-exit-commit", nonce: registration.nonce },
                callback,
              ),
            )
          else process.exit(0)
        })().catch(error => {
          logger.error(M.entry.exitCleanupFailed, error)
          process.exit(1)
        })
      })
    try {
      await waitForBootstrapReady(Bot, settings.startupTimeout, readiness.signal)
    } catch (error) {
      if (exiting) return
      throw error
    }
    if (exiting) return
    if (managedByPm2) {
      // 就绪独立计时；登记与交接共用启动预算，不得中途重置。
      const deadline = inspectorDeadline(settings.startupTimeout)
      const armWatchdog = (maximum: number) => {
        const remaining = Math.floor(Math.min(maximum, deadline.remainingMs()))
        if (remaining <= 0) throw new Error(M.entry.pm2Deadline)
        clearTimeout(bootstrapTimer)
        bootstrapTimer = setTimeout(() => {
          logger.error(M.entry.pm2Timeout)
          process.exit(78)
        }, remaining)
      }
      armWatchdog(settings.startupTimeout)
      try {
        registrationPending = registerCurrentPm2Application(
          {
            root: process.cwd(),
            launcherPath: fileURLToPath(new URL("../launcher.js", import.meta.url)),
            shutdownTimeout: settings.shutdownTimeout,
            startupTimeout: settings.startupTimeout,
            requestRestart: true,
            bootstrapRedisPid: exitPlan.redisPid,
          },
          deadline,
        )
        const registration = await registrationPending
        if (exiting) return
        if (!registration?.requiresHandoff || !registration.nonce)
          throw new Error(M.entry.pm2Unauthorized)
        armWatchdog(settings.handshakeTimeout)
        process.send?.({ type: "yunzai-guard-pm2-handoff", nonce: registration.nonce }, error => {
          if (error) process.exit(78)
        })
        // 登记已请求重启；关闭处理器负责退出，仍受交接期限约束。
        await new Promise<never>(() => {})
      } catch (error) {
        clearTimeout(bootstrapTimer)
        if (exiting) return
        logger.error(M.entry.pm2Failed, error)
        process.exit(78)
      }
    }
    const env = { ...process.env }
    delete env.NODE_OPTIONS
    const host = spawn(
      hostExecutable,
      [
        fileURLToPath(new URL("../host/supervisor.js", import.meta.url)),
        String(process.pid),
        exitPlan.redisPid === null ? "none" : String(exitPlan.redisPid),
      ],
      {
        cwd: process.cwd(),
        env,
        // Windows detached 进程不能继承控制台句柄；Linux 保留 terminal/screen 输出。
        stdio: [
          process.platform === "win32" ? "ignore" : "inherit",
          process.platform === "win32" ? "ignore" : "inherit",
          process.platform === "win32" ? "ignore" : "inherit",
          "ipc",
        ],
        windowsHide: true,
        detached: true,
      },
    )
    try {
      const nonce = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(M.entry.handoffTimeout)),
          settings.handshakeTimeout,
        )
        const fail = (error: Error) => {
          clearTimeout(timer)
          reject(error)
        }
        host.once("error", fail)
        host.once("exit", code => fail(new Error(M.entry.handoffExited(code))))
        host.on("message", (message: unknown) => {
          const reply = message as { type?: string; version?: number; nonce?: unknown }
          if (
            reply?.type !== "armed" ||
            reply.version !== 1 ||
            typeof reply.nonce !== "string" ||
            !/^[a-f0-9]{48}$/.test(reply.nonce)
          )
            return
          clearTimeout(timer)
          resolve(reply.nonce)
        })
      })
      await exitPlan.prepare(settings.shutdownTimeout)
      exitPlan.assertCurrent()
      await commitAndExit(callback =>
        host.send({ type: "bootstrap-handoff-commit", version: 1, nonce }, callback),
      )
    } catch (error) {
      console.error(M.entry.takeoverFailed, (error as Error).message)
      // 断开连接会拒绝未提交的交接，并让宿主关闭其私有观察器。
      // 直接终止宿主会跳过这一步异步清理。
      if (host.pid && host.exitCode === null && host.signalCode === null) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await new Promise<void>((resolve, reject) => {
            const exited = () => {
              clearTimeout(timer)
              resolve()
            }
            host.once("exit", exited)
            timer = setTimeout(
              () => {
                host.off("exit", exited)
                reject(new Error(M.entry.cancelUnconfirmed))
              },
              settings.handshakeTimeout + settings.shutdownTimeout + 5000,
            )
            if (host.connected) host.disconnect()
          })
        } catch (cleanupError) {
          console.error(M.entry.cancelCleanup, (cleanupError as Error).message)
        } finally {
          clearTimeout(timer)
        }
      }
      process.exit(1)
    }
  }
}
