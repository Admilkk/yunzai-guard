import type { AlertCategory, AlertMute, AlertRecord, AlertService, AlertState } from "../host/alerts.js";
import type { BehaviorProfile } from "../host/profile.js";
import type { PluginSource } from "../host/sources.js";
import type { UpdateState } from "../host/update.js";
import type { ResourcePoint } from "../host/usage.js";
/** 宿主提供给面板的扩展能力：告警、行为画像、插件来源与更新还原。 */
export interface PanelControllers {
    alerts: {
        history: (limit: number) => AlertRecord[];
        testWebhook: () => Promise<{
            ok: boolean;
            status?: number;
            error?: string;
        }>;
        state: () => AlertState;
        acknowledge: (ids?: string[]) => void;
        mute: (target: {
            plugin?: string;
            category?: AlertCategory;
        }, minutes: number) => AlertMute;
        unmute: (key: string) => void;
        /** 登记一条告警。 */
        raise: AlertService["raise"];
    };
    profiles: Pick<BehaviorProfile, "summary" | "detail" | "trust" | "forget" | "endLearning" | "reset">;
    sources: {
        list: () => PluginSource[];
        scan: () => Promise<PluginSource[]>;
    };
    resources: {
        points: () => ResourcePoint[];
    };
}
export interface UpdateController {
    state: () => UpdateState;
    check: () => Promise<UpdateState>;
    apply: (force: boolean) => Promise<{
        ok: boolean;
        message: string;
    }>;
    rollback: () => Promise<{
        ok: boolean;
        message: string;
    }>;
    /** 立即执行等待中的业务进程重启，使业务侧更新生效。 */
    applyPending: () => Promise<{
        ok: boolean;
        message: string;
    }>;
}
