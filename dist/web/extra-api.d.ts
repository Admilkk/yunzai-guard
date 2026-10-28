import type http from "node:http";
import type { GuardSettings } from "../shared/types.js";
import type { SettingsApplyState } from "../config/update.js";
import type { PanelControllers } from "./controllers.js";
export interface ExtraContext {
    stateDir: string;
    settings: GuardSettings;
    getSettings?: () => GuardSettings;
    applySettings?: (settings: GuardSettings) => SettingsApplyState;
    controllers?: PanelControllers;
    audit?: (type: string, details?: Record<string, unknown>) => void;
    readBody: (request: http.IncomingMessage) => Promise<unknown>;
    sendJson: (response: http.ServerResponse, status: number, body: unknown) => void;
    fail: (status: number, message: string) => Error;
}
/** 面板扩展接口；未处理的路由返回 false。 */
export declare function handleExtra(context: ExtraContext, route: string, url: URL, request: http.IncomingMessage, response: http.ServerResponse): Promise<boolean>;
