/** 控制台实现的宿主接口版本，宿主加载控制台时核对。 */
export declare const coreProtocol = 2;
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
    /** 上一个控制台交来的内存会话。 */
    handover?: unknown;
}
/** 当前控制台代码的版本，热替换后即为新版本。 */
export declare function panelVersion(): string;
/** 面板与宿主同生命周期：宿主退出后端口随之释放，不会留下孤儿服务。返回是否已在监听。 */
export declare function startPanel(options: StartPanelOptions): Promise<boolean>;
/** 生成一次性登录链接；面板未启动或聊天登录关闭时抛出可读的错误。 */
export declare function panelLoginLink(): {
    urls: string[];
    ttlSeconds: number;
};
/** 取出内存会话，热替换时交给下一个控制台。 */
export declare function panelHandover(): unknown;
/** 停止面板服务。 */
export declare function stopPanel(): Promise<void>;
