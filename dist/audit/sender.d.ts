import { type AuditDeadline, type AuditHopAckFrame, type AuditLossReason, type AuditObservationFrame, type AuditSealFrame, type AuditSourceCounters } from "./protocol.js";
export interface AuditSenderOptions {
    generation: number;
    maxQueue: number;
    maxBytes?: number;
    channelNonce?: string;
    completion: "callback" | "hop";
    write(frame: AuditObservationFrame, callback: (error?: Error | null) => void): boolean | void;
    isConnected(): boolean;
    now?: () => number;
}
export type AuditSenderOffer = {
    accepted: true;
} | {
    accepted: false;
    reason: AuditLossReason | "critical-coalesced";
};
/** 有限的传输投递，不代表宿主追加落盘或策略授权回执。 */
export declare class AuditSender {
    #private;
    /** 创建工作进程端审计发送器。 */
    constructor(options: AuditSenderOptions);
    /** 绑定宿主下发的通道随机串，只能绑定一次。 */
    bindChannel(nonce: string): boolean;
    /** 提交一条事件，返回接受结果或拒绝原因。 */
    offer(event: Record<string, unknown>, critical?: boolean): AuditSenderOffer;
    /** 处理宿主确认帧，返回是否为有效确认。 */
    ack(frame: AuditHopAckFrame): boolean;
    /** 通道可写后恢复发送。 */
    resume(): void;
    /** 返回计数器副本。 */
    counters(): AuditSourceCounters;
    /** 立即生成密封帧，不等待在途事件。 */
    sealNow(options: {
        nonce: string;
        nestedCoverage?: AuditSealFrame["nestedCoverage"];
    }): AuditSealFrame;
    /** 在截止时间内等待在途事件后发送密封帧。 */
    seal(options: {
        nonce: string;
        deadline: AuditDeadline;
        nestedCoverage?: AuditSealFrame["nestedCoverage"];
    }): Promise<AuditSealFrame>;
    /** 停止发送并把未完成事件记为断开。 */
    dispose(): void;
}
