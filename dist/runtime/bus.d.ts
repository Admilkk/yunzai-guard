import type { MonitorReport } from "../monitor/report.js";
import type { GuardContext, GuardEvent } from "../shared/types.js";
export type Command = {
    type: "restart-request" | "stop-request" | "update-request" | "update-force-request" | "rollback-request";
    reason?: string;
};
export type Notice = {
    type: "preload-ready" | "worker-online";
} | {
    type: "monitor-report";
    report: MonitorReport;
};
interface BusOptions {
    generation: number;
    pid: number;
    controlKey: string;
    connected(): boolean;
    offer(event: Record<string, unknown>, critical: boolean): void;
    write(message: Record<string, unknown>, done: (error: Error | null) => void): unknown;
    fail(): void;
}
/**
 * 工作进程到宿主的唯一出口：遥测进入审计队列，控制与通知走 IPC。
 * 同类帧在途时只保留最新一份，写入完成后补发，避免慢通道积压或丢失最终状态。
 */
export declare class RuntimeBus {
    #private;
    /** 以每代控制密钥创建总线。 */
    constructor(options: BusOptions);
    /** 提交审计事件。 */
    audit: (event: GuardEvent) => void;
    /** 发送带签名的控制指令。 */
    command: (command: Command) => void;
    /** 发送通知；控制类通知同样签名。 */
    notify: (notice: Notice) => void;
    /** 公开上下文只接受遥测，控制指令使用实例内的受信入口。 */
    send: GuardContext["send"];
}
export {};
