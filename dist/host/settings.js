import { parseSettings } from "../config/index.js";
import { planSettingsUpdate, } from "../config/update.js";
/** 根据更新计划生成配置应用状态。 */
function stateFor(plan, revision, settled = false) {
    const applying = !settled && (plan.liveFields.length > 0 || plan.reloadFields.length > 0);
    const state = {
        status: applying ? "applying" : plan.restartFields.length ? "pending-restart" : "applied",
        mode: applying && plan.reloadFields.length
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
    };
    return freezeState(state);
}
/** 冻结应用状态及其字段列表。 */
function freezeState(state) {
    Object.freeze(state.liveFields);
    Object.freeze(state.reloadFields);
    Object.freeze(state.restartFields);
    return Object.freeze(state);
}
export class SettingsController {
    #operations;
    #active;
    #state;
    #revision = 0;
    #pending;
    /** 创建配置应用协调器。 */
    constructor(active, operations) {
        this.#active = parseSettings(active);
        this.#operations = operations;
        this.#state = stateFor(planSettingsUpdate(this.#active, this.#active), 0);
    }
    /** 当前已生效的配置。 */
    get active() {
        return this.#active;
    }
    /** 当前应用状态。 */
    get state() {
        return this.#state;
    }
    /** 是否有待应用的配置。 */
    get hasPending() {
        return this.#pending !== undefined;
    }
    /** 请求应用新配置，返回最新状态。 */
    request(next) {
        const desired = parseSettings(next);
        const plan = planSettingsUpdate(this.#active, desired);
        this.#pending = { revision: ++this.#revision, next: desired };
        this.#state = stateFor(plan, this.#revision);
        return this.#state;
    }
    /** 重新计算待应用配置，返回是否仍有变化。 */
    #refreshPending() {
        if (!this.#pending)
            return false;
        this.#state = stateFor(planSettingsUpdate(this.#active, this.#pending.next), this.#pending.revision);
        return true;
    }
    /** 由宿主生命周期队列串行调用；新保存始终留给下一次应用。 */
    async applyPending() {
        const request = this.#pending;
        if (!request)
            return this.#state;
        this.#pending = undefined;
        const plan = planSettingsUpdate(this.#active, request.next);
        this.#state = stateFor(plan, request.revision);
        try {
            let prepared;
            if (plan.reloadFields.length) {
                prepared = await this.#operations.prepare(plan.candidate);
                if (this.#refreshPending())
                    return this.#state;
            }
            if (plan.liveFields.length) {
                await this.#operations.applyLive(plan.live);
                this.#active = plan.live;
                if (this.#refreshPending())
                    return this.#state;
            }
            if (plan.reloadFields.length) {
                await this.#operations.reload(plan.candidate, prepared);
                this.#active = plan.candidate;
            }
            if (!this.#refreshPending())
                this.#state = stateFor(plan, request.revision, true);
        }
        catch (error) {
            if (!this.#refreshPending())
                this.#state = freezeState({
                    ...stateFor(plan, request.revision),
                    status: "failed",
                    error: error instanceof Error ? error.message : String(error),
                });
        }
        return this.#state;
    }
}
//# sourceMappingURL=settings.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("host/settings.ts", { SettingsController })
