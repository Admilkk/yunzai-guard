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
    /** 上一个控制台交来的内存会话。 */
    handover?: unknown;
}
export declare class GuardPanel {
    #private;
    readonly root: string;
    /** 创建面板服务。 */
    constructor(options: PanelOptions);
    /** 交给下一个控制台的内存会话。 */
    handover(): unknown;
    /** 当前面板配置。 */
    get settings(): PanelSettings;
    /** 是否正在监听。 */
    get listening(): boolean;
    /** 实际监听端口。 */
    get port(): number;
    /** 绑定 0.0.0.0 时同时给出回环与内网地址。 */
    get urls(): string[];
    /**
     * 生成一次性登录链接。令牌放在地址片段里，不会出现在请求行与代理日志中；
     * 设置了外部访问地址时只给该地址，否则给出全部监听地址。
     */
    loginLink(): {
        urls: string[];
        ttlSeconds: number;
    };
    /** 启动面板服务并打印访问地址。 */
    start(): Promise<boolean>;
    /** 停止面板服务。 */
    stop(): Promise<void>;
}
