import type { AlertRecord } from "../host/alerts.js";
import type { BehaviorProfile } from "../host/profile.js";
import type { PluginSource } from "../host/sources.js";
import type { UpdateState } from "../host/update.js";
/** 宿主提供给面板的扩展能力：告警、行为画像、插件来源与更新还原。 */
export interface PanelControllers {
    alerts: {
        history: (limit: number) => AlertRecord[];
        testWebhook: () => Promise<{
            ok: boolean;
            status?: number;
            error?: string;
        }>;
    };
    profiles: Pick<BehaviorProfile, "summary" | "detail" | "trust" | "forget" | "endLearning" | "reset">;
    sources: {
        list: () => PluginSource[];
        scan: () => Promise<PluginSource[]>;
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
}
