import type { GuardSettings } from "../shared/types.js";
export type AlertCategory = keyof GuardSettings["alerts"]["on"];
export interface AlertRecord {
    /** 告警编号；旧记录缺省时以时间代替。 */
    id: string;
    time: number;
    category: AlertCategory | "digest";
    title: string;
    text: string;
    plugin?: string;
    severity?: string;
    /** 已被静默：只留历史，不推送。 */
    muted?: boolean;
}
/** 静默条件：按插件或按类别，到期自动失效。 */
export interface AlertMute {
    key: string;
    plugin?: string;
    category?: AlertCategory;
    until: number;
}
export interface AlertState {
    /** 此时间点之前的告警视为已读。 */
    readBefore: number;
    /** 之后单独标记已读的告警编号。 */
    read: string[];
    mutes: AlertMute[];
}
interface AlertOptions {
    settings: () => GuardSettings;
    stateDir: string;
    projectId: string;
    /** 立即送达主人；业务进程不在线时返回 false，消息留待上线后补发。 */
    send: (text: string) => boolean;
    record: (type: string, details?: Record<string, unknown>) => void;
}
/**
 * 告警出口：把拦截、熔断、完整性、异常与更新结果推给主人，并可转发到 Webhook。
 * 同类告警按窗口限流，超出的合并成一条摘要。
 */
export declare class AlertService {
    #private;
    /** 记录告警历史到状态目录。 */
    constructor(options: AlertOptions);
    /** 已读标记与静默条件；顺带清掉已过期的静默。 */
    state(): AlertState;
    /** 标记已读：不带编号时全部标为已读。 */
    acknowledge(ids?: string[]): void;
    /** 静默某个插件或某类告警一段时间；同一条件重复设置只刷新到期时间。 */
    mute(target: {
        plugin?: string;
        category?: AlertCategory;
    }, minutes: number): AlertMute;
    /** 取消静默。 */
    unmute(key: string): void;
    /** 登记一条告警：未启用的类别直接忽略，同类重复与超量的合并到摘要。 */
    raise(category: AlertCategory, title: string, text: string, meta?: {
        key?: string;
        plugin?: string;
        severity?: string;
    }): void;
    /** 把审计事件转为告警，并按转发设置加入 Webhook 队列。 */
    onEvent(event: Record<string, unknown>): void;
    /** 补发业务进程不在线时留存的主人通知。 */
    flush(): void;
    /** 最近的告警历史，新的在前；跳过损坏或缺少展示字段的记录。 */
    history(limit?: number): AlertRecord[];
    /** 向 Webhook 发送一条测试消息。 */
    testWebhook(): Promise<{
        ok: boolean;
        status?: number;
        error?: string;
    }>;
    /** 停止定时器，尽量发出剩余的转发队列。 */
    stop(): void;
}
export {};
