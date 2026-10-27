import { parseSettings } from "../config/index.js"
import {
  planSettingsUpdate,
  type SettingsApplyState,
  type SettingsUpdatePlan,
} from "../config/update.js"
import type { GuardSettings } from "../shared/types.js"

export interface SettingsOperations<Prepared> {
  prepare: (candidate: GuardSettings) => Promise<Prepared>
  applyLive: (live: GuardSettings) => void | Promise<void>
  reload: (candidate: GuardSettings, prepared: Prepared) => Promise<void>
}

interface Request {
  revision: number
  next: GuardSettings
}

/** 根据更新计划生成配置应用状态。 */
function stateFor(plan: SettingsUpdatePlan, revision: number, settled = false): SettingsApplyState {
  const applying = !settled && (plan.liveFields.length > 0 || plan.reloadFields.length > 0)
  const state: SettingsApplyState = {
    status: applying ? "applying" : plan.restartFields.length ? "pending-restart" : "applied",
    mode:
      applying && plan.reloadFields.length
        ? "worker-reload"
        : plan.restartFields.length
          ? "host-restart"
          : plan.reloadFields.length
            ? "worker-reload"
            : "live",
    revision,
    liveFields: [...plan.liveFields],
    reloadFields: [...plan.reloadFields],
    restartFields: [...plan.restartFields],
  }
  return freezeState(state)
}

/** 冻结应用状态及其字段列表。 */
function freezeState(state: SettingsApplyState): SettingsApplyState {
  Object.freeze(state.liveFields)
  Object.freeze(state.reloadFields)
  Object.freeze(state.restartFields)
  return Object.freeze(state)
}

export class SettingsController<Prepared = void> {
  readonly #operations: SettingsOperations<Prepared>
  #active: GuardSettings
  #state: SettingsApplyState
  #revision = 0
  #pending?: Request

  /** 创建配置应用协调器。 */
  constructor(active: GuardSettings, operations: SettingsOperations<Prepared>) {
    this.#active = parseSettings(active)
    this.#operations = operations
    this.#state = stateFor(planSettingsUpdate(this.#active, this.#active), 0)
  }

  /** 当前已生效的配置。 */
  get active(): GuardSettings {
    return this.#active
  }

  /** 当前应用状态。 */
  get state(): SettingsApplyState {
    return this.#state
  }

  /** 是否有待应用的配置。 */
  get hasPending(): boolean {
    return this.#pending !== undefined
  }

  /** 请求应用新配置，返回最新状态。 */
  request(next: GuardSettings): SettingsApplyState {
    const desired = parseSettings(next)
    const plan = planSettingsUpdate(this.#active, desired)
    this.#pending = { revision: ++this.#revision, next: desired }
    this.#state = stateFor(plan, this.#revision)
    return this.#state
  }

  /** 重新计算待应用配置，返回是否仍有变化。 */
  #refreshPending(): boolean {
    if (!this.#pending) return false
    this.#state = stateFor(
      planSettingsUpdate(this.#active, this.#pending.next),
      this.#pending.revision,
    )
    return true
  }

  /** 由宿主生命周期队列串行调用；新保存始终留给下一次应用。 */
  async applyPending(): Promise<SettingsApplyState> {
    const request = this.#pending
    if (!request) return this.#state
    this.#pending = undefined
    const plan = planSettingsUpdate(this.#active, request.next)
    this.#state = stateFor(plan, request.revision)
    try {
      let prepared: Prepared | undefined
      if (plan.reloadFields.length) {
        prepared = await this.#operations.prepare(plan.candidate)
        if (this.#refreshPending()) return this.#state
      }
      if (plan.liveFields.length) {
        await this.#operations.applyLive(plan.live)
        this.#active = plan.live
        if (this.#refreshPending()) return this.#state
      }
      if (plan.reloadFields.length) {
        await this.#operations.reload(plan.candidate, prepared as Prepared)
        this.#active = plan.candidate
      }
      if (!this.#refreshPending()) this.#state = stateFor(plan, request.revision, true)
    } catch (error) {
      if (!this.#refreshPending())
        this.#state = freezeState({
          ...stateFor(plan, request.revision),
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        })
    }
    return this.#state
  }
}
