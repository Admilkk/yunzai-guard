import { AuditBuffer, type AuditClosePermit } from "./buffer.js";
import { type AuditDeadline, type AuditFlushResultFrame, type AuditHopAckFrame, type AuditSealFrame } from "./protocol.js";
type Reply = (frame: AuditHopAckFrame | AuditFlushResultFrame) => void;
/** 永久缺口只需保留一个边界，无须永久保存每个后续序号。 */
declare class Prefix {
    through: number;
    blockedAt: number;
    private completed;
    /** 已完成区间的数量。 */
    get ranges(): number;
    /** 从指定序号起阻断结算，并丢弃之后的已完成区间。 */
    block(sequence: number): void;
    /** 登记一个序号已结算，必要时合并相邻区间。 */
    settle(sequence: number): boolean;
}
interface Source {
    id: number;
    key: string;
    channelNonce: string;
    transport: "primary-ipc" | "broker-connection";
    lastReceived: number;
    receivedThrough: number;
    receivedGap: boolean;
    missing: number;
    invalid: number;
    written: number;
    rejected: number;
    unknown: number;
    pending: Set<number>;
    settled: Prefix;
    appended: Prefix;
    seal?: AuditSealFrame;
    result?: AuditFlushResultFrame;
    dropped: boolean;
    transportUnknown: number;
    finishing: boolean;
    deadlineExceeded: boolean;
}
export interface AuditReceiverOptions {
    generation: number;
    buffer: AuditBuffer;
    authorize(event: unknown): Record<string, unknown> | undefined;
    /** 证据入队前执行已授权策略；审计帧不能决定动作。 */
    onAction(event: Record<string, unknown>): void;
    onInvalid?(): void;
}
/** 仅处理一个代次，以宿主持有的通道为键，不使用客体 PID 或运行时标签。 */
export declare class AuditReceiver {
    private readonly options;
    private readonly sources;
    private closeOptions?;
    private permit?;
    private invalid;
    private nextSourceId;
    private retired;
    /** 创建宿主端审计接收器。 */
    constructor(options: AuditReceiverOptions);
    /** 登记一个审计来源及其通道随机串。 */
    register(key: string, channelNonce: string, transport: Source["transport"]): void;
    /** 进入关闭阶段并记录截止时间。 */
    prepare(options: {
        nonce: string;
        deadline: AuditDeadline;
    }): void;
    /** 累计无效帧数量。 */
    private bad;
    /** 接收并校验来源发来的一帧，按类型入队、结算或回复。 */
    receive(key: string, raw: unknown, reply: Reply): boolean;
    /** 处理缓冲区回执，更新来源的待结算与已写入状态。 */
    private settle;
    /** 向来源回复确认帧。 */
    private reply;
    /** 出站通道操作失败只记为一次事件，不等同于丢失审计记录数。 */
    noteOutboundFailure(key: string): void;
    /** 惰性创建本代次的关闭许可。 */
    private closePermit;
    /** 来源已密封时，等待其事件结算后回复最终结果。 */
    private finishSource;
    /** 来源断开时记录未知数量并退役。 */
    drop(key: string, transportUnknown?: number): void;
    /** 把短期来源的统计并入退役汇总，释放活动名额。 */
    private retire;
    /** 在关闭截止时间内提交全部已接收事件。 */
    flush(): Promise<void>;
    /** 返回宿主关闭缓冲区所需的许可。 */
    closePermitForHost(): AuditClosePermit;
    /** 汇总来源自报与接收端观测到的丢失数量。 */
    private sourceLoss;
    /** 返回接收器与各来源的统计快照。 */
    stats(): {
        generation: number;
        invalidFrames: number;
        retired: {
            sources: number;
            sealed: number;
            missingSeal: number;
            written: number;
            rejected: number;
            unknown: number;
            sourceRejected: number;
            sourceCoalesced: number;
            sourcePendingRecords: number;
            allOfferedWritten: number;
            settledWithLoss: number;
            incomplete: number;
        };
        sources: {
            sourceId: number;
            transport: "primary-ipc" | "broker-connection";
            received: number;
            receivedThrough: number;
            written: number;
            rejected: number;
            unknown: number;
            sourceLoss: {
                unknown: number;
                rejected: number;
                coalesced: number;
                pendingRecords: number;
            };
            transportUnknown: number;
            pending: number;
            sealed: boolean;
            bookkeepingRanges: number;
            deadlineExceeded: boolean;
            receiptDelivery: string;
            outcome: import("./protocol.js").AuditFlushOutcome;
            nestedCoverage: "settled" | "incomplete" | "unknown";
            evidence: string;
            dropped: boolean;
        }[];
    };
}
export {};
