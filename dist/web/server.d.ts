import type { GuardSettings } from "../shared/types.js";
import type { SettingsApplyState } from "../config/update.js";
import { type PanelSettings } from "./panel-settings.js";
import type { PanelControllers, UpdateController } from "./controllers.js";
export interface PanelOptions {
    root: string;
    stateDir: string;
    settings: GuardSettings;
    getSettings?: () => GuardSettings;
    configuration?: () => SettingsApplyState;
    applySettings?: (settings: GuardSettings) => SettingsApplyState;
    version: string;
    status: () => Record<string, unknown>;
    update?: UpdateController;
    controllers?: PanelControllers;
    restart: () => void;
    resume: () => void;
    audit?: (type: string, details?: Record<string, unknown>) => void;
    log?: (message: string) => void;
}
export declare class GuardPanel {
    #private;
    readonly root: string;
    /** 创建面板服务。 */
    constructor(options: PanelOptions);
    /** 当前面板配置。 */
    get settings(): PanelSettings;
    /** 是否正在监听。 */
    get listening(): boolean;
    /** 实际监听端口。 */
    get port(): number;
    /** 绑定 0.0.0.0 时同时给出回环与内网地址。 */
    get urls(): string[];
    /** 启动面板服务并打印访问地址。 */
    start(): Promise<boolean>;
    /** 停止面板服务。 */
    stop(): Promise<void>;
}
