import fs from "node:fs"
import path from "node:path"
import { MessageChannel, Worker, type MessagePort } from "node:worker_threads"
import {
  coreProtocolVersion,
  restoreError,
  serveCalls,
  type CoreCommand,
  type CoreEvent,
  type CoreHandlers,
  type CoreReply,
} from "../web/core-protocol.js"
import { M } from "../shared/messages.js"

export interface CoreHostOptions {
  stateDir: string
  /** Yunzai 根目录。 */
  root: string
  /** 启动线程时传入的当前配置快照。 */
  settings: () => unknown
  /** 线程可调用的宿主能力。 */
  handlers: CoreHandlers
  record: (type: string, details?: Record<string, unknown>) => void
}

const readyTimeoutMs = 20_000
const stopTimeoutMs = 3_000
const linkTimeoutMs = 5_000
const crashWindowMs = 5 * 60_000
const maxCrashes = 3

interface Running {
  thread: Worker
  ports: MessagePort[]
  pluginDir: string
  version: string
  listening: boolean
}

/**
 * 控制台线程的宿主端：在宿主进程内启动、停止与替换控制台线程。
 * 线程从哪个插件目录加载由调用方决定，热更新时可以先从暂存目录运行新版本。
 * 线程崩溃不会影响宿主与业务进程，短时间内反复崩溃时停止重启并留下记录。
 */
export class CoreHost {
  readonly #options: CoreHostOptions
  #running: Running | undefined
  #stopping = false
  #crashes: number[] = []
  #linkSequence = 0
  /** 上一个线程交出的内存会话，下一次启动时交给新线程。 */
  #handover: unknown
  readonly #links = new Map<number, (reply: CoreReply) => void>()

  /** 创建控制台线程管理器。 */
  constructor(options: CoreHostOptions) {
    this.#options = options
  }

  /** 当前线程加载的插件目录。 */
  get pluginDir(): string | undefined {
    return this.#running?.pluginDir
  }

  /** 当前线程中的控制台版本。 */
  get version(): string | undefined {
    return this.#running?.version
  }

  /** 从指定插件目录启动控制台线程，等待其就绪。 */
  async start(pluginDir: string): Promise<boolean> {
    if (this.#running) return true
    this.#stopping = false
    const entry = path.join(pluginDir, "dist", "web", "thread.js")
    if (!fs.existsSync(entry)) {
      this.#options.record("core-start-failed", { pluginDir, message: "missing-entry" })
      return false
    }
    const sync = new MessageChannel()
    const background = new MessageChannel()
    const signal = new SharedArrayBuffer(4)
    serveCalls(sync.port1, this.#options.handlers, signal)
    serveCalls(background.port1, this.#options.handlers)
    const ports = [sync.port1, background.port1]
    let thread: Worker
    try {
      thread = new Worker(entry, {
        workerData: {
          protocol: coreProtocolVersion,
          root: this.#options.root,
          stateDir: this.#options.stateDir,
          settings: this.#options.settings(),
          syncPort: sync.port2,
          asyncPort: background.port2,
          signal,
          handover: this.#handover,
        },
        transferList: [sync.port2, background.port2],
      })
    } catch (error) {
      for (const port of ports) port.close()
      this.#options.record("core-start-failed", { pluginDir, message: (error as Error).message })
      return false
    }
    const ready = await new Promise<CoreEvent | Error>(resolve => {
      const timer = setTimeout(() => resolve(new Error("timeout")), readyTimeoutMs)
      const settle = (value: CoreEvent | Error): void => {
        clearTimeout(timer)
        thread.off("message", onMessage)
        thread.off("error", onError)
        thread.off("exit", onExit)
        resolve(value)
      }
      const onMessage = (event: CoreEvent): void => {
        if (event?.type === "ready") settle(event)
      }
      const onError = (error: Error): void => settle(error)
      const onExit = (code: number): void => settle(new Error(`exit ${code}`))
      thread.on("message", onMessage)
      thread.once("error", onError)
      thread.once("exit", onExit)
    })
    if (ready instanceof Error || ready.type !== "ready") {
      await thread.terminate().catch(() => undefined)
      for (const port of ports) port.close()
      this.#options.record("core-start-failed", {
        pluginDir,
        message: ready instanceof Error ? ready.message : "unexpected",
      })
      return false
    }
    const running: Running = {
      thread,
      ports,
      pluginDir,
      version: ready.version,
      listening: ready.listening,
    }
    this.#running = running
    this.#handover = undefined
    thread.on("message", (event: CoreEvent) => {
      if (event?.type === "login-link-result") this.#links.get(event.reply.id)?.(event.reply)
    })
    thread.on("error", error =>
      this.#options.record("core-thread-error", { message: error.message }),
    )
    thread.once("exit", code => this.#exited(running, code))
    this.#options.record("core-started", {
      pluginDir,
      version: ready.version,
      listening: ready.listening,
    })
    return true
  }

  /** 停止控制台线程：先让控制台关闭端口，超时后强制结束线程。 */
  async stop(): Promise<void> {
    const running = this.#running
    if (!running) return
    this.#stopping = true
    this.#running = undefined
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, stopTimeoutMs)
      running.thread.on("message", (event: CoreEvent) => {
        if (event?.type !== "stopped") return
        this.#handover = event.handover
        clearTimeout(timer)
        resolve()
      })
      running.thread.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        running.thread.postMessage({ type: "stop" } satisfies CoreCommand)
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
    await running.thread.terminate().catch(() => undefined)
    for (const port of running.ports) port.close()
    this.#options.record("core-stopped", { pluginDir: running.pluginDir })
  }

  /**
   * 换成另一个插件目录中的控制台。新线程未能就绪时回到原目录，返回 false。
   * 控制台在两次监听之间短暂不可用，浏览器会自动重连。
   */
  async swap(pluginDir: string): Promise<boolean> {
    const previous = this.#running?.pluginDir
    await this.stop()
    if (await this.start(pluginDir)) return true
    if (previous) await this.start(previous)
    return false
  }

  /** 请求控制台生成一次性登录链接。 */
  loginLink(): Promise<{ urls: string[]; ttlSeconds: number }> {
    const running = this.#running
    if (!running) return Promise.reject(new Error(M.web.linkPanelOff))
    const id = ++this.#linkSequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#links.delete(id)
        reject(new Error(M.web.linkPanelOff))
      }, linkTimeoutMs)
      this.#links.set(id, reply => {
        clearTimeout(timer)
        this.#links.delete(id)
        if (reply.ok) resolve(reply.value as { urls: string[]; ttlSeconds: number })
        else reject(restoreError(reply.error))
      })
      running.thread.postMessage({ type: "login-link", id } satisfies CoreCommand)
    })
  }

  /** 线程意外退出：记录并从原目录重启；短时间内反复崩溃则不再重启。 */
  #exited(running: Running, code: number): void {
    for (const port of running.ports) port.close()
    if (this.#running !== running || this.#stopping) return
    this.#running = undefined
    const now = Date.now()
    this.#crashes = [...this.#crashes.filter(time => now - time < crashWindowMs), now]
    this.#options.record("core-thread-exit", { code, crashes: this.#crashes.length })
    if (this.#crashes.length > maxCrashes) {
      this.#options.record("core-restart-abandoned", { pluginDir: running.pluginDir })
      return
    }
    setTimeout(() => void this.start(running.pluginDir), 1000).unref()
  }
}
