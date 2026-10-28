import { type PanelSettings } from "./panel-settings.js";
export declare class PanelError extends Error {
    readonly status: number;
    readonly retryAfter?: number | undefined;
    /** 创建带 HTTP 状态码的面板错误。 */
    constructor(status: number, message: string, retryAfter?: number | undefined);
}
interface Session {
    id: string;
    createdAt: number;
    lastSeenAt: number;
    expiresAt: number;
    remember: boolean;
    address: string;
    userAgent: string;
}
export interface SessionOptions {
    remember?: boolean;
    address?: string;
    userAgent?: string;
}
export interface SessionSummary extends Session {
    current: boolean;
}
export declare class PanelAuth {
    #private;
    /** 创建会话管理器，可选持久化到状态目录。 */
    constructor(settings: () => PanelSettings, stateDir?: string);
    /** 当前有效会话数。 */
    get tokenCount(): number;
    /** 签发新会话令牌。 */
    issue(options?: SessionOptions): string;
    /** 校验会话令牌并刷新最近使用时间。 */
    verify(token: unknown): Record<string, unknown> | undefined;
    /** 返回会话对应的 CSRF 令牌。 */
    csrf(token: unknown): string;
    /** 校验 CSRF 令牌。 */
    verifyCsrf(token: unknown, value: unknown): boolean;
    /** 列出有效会话，标记当前会话。 */
    sessions(currentToken?: unknown): SessionSummary[];
    /** 撤销指定会话。 */
    revoke(id: unknown): boolean;
    /** 注销当前会话。 */
    logout(token: unknown): void;
    /** 生成一次性登录验证码，已有有效验证码时拒绝。 */
    requestCode(): string;
    /** 校验登录验证码并签发会话，失败次数超限时暂时封禁来源。 */
    checkCode(input: unknown, address: string, options?: SessionOptions): string;
}
export {};
