import { type SettingsApplyState } from "../config/update.js";
import type { GuardSettings } from "../shared/types.js";
export interface SettingsOperations<Prepared> {
    prepare: (candidate: GuardSettings) => Promise<Prepared>;
    applyLive: (live: GuardSettings) => void | Promise<void>;
    reload: (candidate: GuardSettings, prepared: Prepared) => Promise<void>;
}
export declare class SettingsController<Prepared = void> {
    #private;
    /** 创建配置应用协调器。 */
    constructor(active: GuardSettings, operations: SettingsOperations<Prepared>);
    /** 当前已生效的配置。 */
    get active(): GuardSettings;
    /** 当前应用状态。 */
    get state(): SettingsApplyState;
    /** 是否有待应用的配置。 */
    get hasPending(): boolean;
    /** 请求应用新配置，返回最新状态。 */
    request(next: GuardSettings): SettingsApplyState;
    /** 由宿主生命周期队列串行调用；新保存始终留给下一次应用。 */
    applyPending(): Promise<SettingsApplyState>;
}
