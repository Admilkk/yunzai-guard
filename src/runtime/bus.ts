import type { MonitorReport } from "../monitor/report.js"
import type { GuardContext, GuardEvent } from "../shared/types.js"
import {
  error,
  mapDelete,
  mapGet,
  mapHas,
  mapSet,
  newMap,
  objectFreeze,
} from "../protect/intrinsics.js"
import { createControlSigner, isControlType } from "./control.js"
import { M } from "../shared/messages.js"

export type Command = {
  type: "restart-request" | "stop-request"
  reason?: string
}

export type Notice =
  { type: "preload-ready" | "worker-online" } | { type: "monitor-report"; report: MonitorReport }

interface BusOptions {
  generation: number
  pid: number
  controlKey: string
  connected(): boolean
  offer(event: Record<string, unknown>, critical: boolean): void
  write(message: Record<string, unknown>, done: (error: Error | null) => void): unknown
  fail(): void
}

/**
 * 工作进程到宿主的唯一出口：遥测进入审计队列，控制与通知走 IPC。
 * 同类帧在途时只保留最新一份，写入完成后补发，避免慢通道积压或丢失最终状态。
 */
export class RuntimeBus {
  /** 键存在表示该类型在途；值为在途期间到达的最新附加字段。 */
  readonly #pending = newMap<string, Record<string, unknown> | undefined>()
  readonly #options: BusOptions
  readonly #sign: ReturnType<typeof createControlSigner>

  /** 以每代控制密钥创建总线。 */
  constructor(options: BusOptions) {
    this.#options = options
    this.#sign = createControlSigner(options.controlKey, options.generation, options.pid)
    objectFreeze(this)
  }

  /** 提交审计事件。 */
  audit = (event: GuardEvent): void => {
    this.#offer(event)
  }

  /** 发送带签名的控制指令。 */
  command = (command: Command): void => {
    const { type, ...extra } = command
    this.#write(type, extra)
  }

  /** 发送通知；控制类通知同样签名。 */
  notify = (notice: Notice): void => {
    const { type, ...extra } = notice
    this.#write(type, extra)
  }

  /** 公开上下文只接受遥测，控制指令使用实例内的受信入口。 */
  send: GuardContext["send"] = (type, extra = {}) => {
    if (type === "audit" || type === "violation") {
      this.#offer(extra.event as GuardEvent, type === "violation")
      return
    }
    const failure = error(M.runtime.untrustedControl) as Error & {
      code: string
    }
    failure.code = "ERR_GUARD_SELF_PROTECTION"
    throw failure
  }

  /** 把事件交给审计队列，拒绝与重启视为关键事件。 */
  #offer(event: GuardEvent, critical = false): void {
    this.#options.offer(
      event as unknown as Record<string, unknown>,
      critical || event?.action === "deny" || event?.action === "restart",
    )
  }

  /** 写入一帧 IPC 消息；同类在途时合并为最新一帧。 */
  #write(type: string, extra: Record<string, unknown>): void {
    const options = this.#options
    if (!options.connected()) return options.fail()
    // 控制指令重复无意义；通知只需送达最新状态。
    if (mapHas(this.#pending, type)) {
      if (!isControlType(type)) mapSet(this.#pending, type, extra)
      return
    }
    mapSet(this.#pending, type, undefined)
    try {
      const frame = isControlType(type)
        ? this.#sign(type)
        : { type, generation: options.generation, pid: options.pid }
      options.write({ __proto__: null, ...extra, ...frame }, error => {
        const next = mapGet(this.#pending, type)
        mapDelete(this.#pending, type)
        if (error) return options.fail()
        if (next) this.#write(type, next)
      })
    } catch {
      mapDelete(this.#pending, type)
      options.fail()
    }
  }
}
