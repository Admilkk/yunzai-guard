import type { GuardSettings } from "../shared/types.js";
import type { SettingsApplyState } from "../config/update.js";
import type { PanelControllers, UpdateController } from "./controllers.js";
export interface StartPanelOptions {
    root: string;
    stateDir: string;
    settings: GuardSettings;
    getSettings?: () => GuardSettings;
    configuration?: () => SettingsApplyState;
    applySettings?: (settings: GuardSettings) => SettingsApplyState;
    status: () => Record<string, unknown>;
    update?: UpdateController;
    controllers?: PanelControllers;
    restart: () => void;
    resume: () => void;
    audit?: (type: string, details?: Record<string, unknown>) => void;
}
/** 面板与宿主同生命周期：宿主退出后端口随之释放，不会留下孤儿服务。 */
export declare function startPanel(options: StartPanelOptions): Promise<void>;
/** 停止面板服务。 */
export declare function stopPanel(): Promise<void>;
