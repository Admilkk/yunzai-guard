import net from "node:net";
import type { GuardEvent, GuardSettings } from "../shared/types.js";
import { type AuditDeadline, type AuditFlushResultFrame, type AuditHopAckFrame, type AuditObservationFrame, type AuditSealFrame } from "../audit/protocol.js";
import type { RuntimeManifest } from "./protocol.js";
export type { RuntimeManifest } from "./protocol.js";
interface Peer {
    id?: string;
    originPlugin?: string;
    channelNonce: string;
    lastSequence: number;
    counters: RuntimeAuditPeerCounters;
    seal?: AuditSealFrame;
    flushResultSent?: boolean;
    dropped: boolean;
    send: (message: Record<string, unknown>, callback?: (error?: Error | null) => void) => void | boolean;
    close: () => void;
}
export interface RuntimeAuditPeerCounters {
    received: number;
    invalidFrames: number;
    sendErrors: number;
    unknown: number;
}
export interface RuntimeAuditSource {
    /** 连接键由接收端持有；客体运行时标签和 PID 不构成可信身份。 */
    key: string;
    generation: number;
    channelNonce: string;
    transport: "broker-connection";
    provenance: "host-owned-channel";
    runtimeIdLabel: string;
}
type AuditReply = (frame: AuditHopAckFrame | AuditFlushResultFrame) => void;
export interface RuntimeAuditCallbacks {
    onSource(source: RuntimeAuditSource): void;
    onObservation(input: {
        key: string;
        frame: AuditObservationFrame;
    }, reply: AuditReply): void;
    onSeal(input: {
        key: string;
        frame: AuditSealFrame;
    }, reply: AuditReply): void;
    onDrop(input: {
        key: string;
        counters: RuntimeAuditPeerCounters;
        reason: string;
    }): void;
}
export interface RuntimeAuditCloseOptions {
    deadline: AuditDeadline;
    nonce: string;
}
/** 限制宿主实际 socket 写队列；尝试发送不代表对端已接收。 */
export declare function writeBrokerSocketFrame(socket: Pick<net.Socket, "write" | "writableLength" | "destroyed">, message: Record<string, unknown>, callback?: (error?: Error | null) => void): boolean;
/** 每代独立的审计端点，不执行管理命令或修改宿主设置。 */
export declare class RuntimeBroker {
    #private;
    readonly directory: string;
    readonly manifestPath: string;
    readonly manifest: RuntimeManifest;
    /** 返回各连接的传输计数汇总。 */
    transportStats(): {
        offered: number;
        submitted: number;
        completed: number;
        rejected: number;
        sendErrors: number;
        channelErrors: number;
        unknown: number;
        afterDropErrors: number;
        closed: number;
        scope: "broker-outbound-only";
        evidence: "transport-callback-only";
        provenance: "host-owned";
    };
    /** 记录一次出站发送失败，必要时断开该连接。 */
    private outboundFailure;
    /** 已完成握手的运行时数量。 */
    get activeRuntimes(): number;
    /** 创建运行时代理，负责接收子进程与线程的审计事件。 */
    constructor(settings: GuardSettings, generation: number, projectId: string, onEvent: (kind: "audit" | "violation", event: GuardEvent) => void, auditCallbacks?: RuntimeAuditCallbacks);
    /** 删除代理使用的私有套接字目录。 */
    private removeDirectory;
    /** 开始监听本地套接字；AppContainer 模式下由辅助进程提供管道。 */
    listen(nativeWindowsPipe?: boolean): Promise<void>;
    /** 原生辅助进程已确认连接的 Windows 进程属于当前 Job Object。 */
    receiveNative(key: string, message: unknown, send: Peer["send"], close: Peer["close"]): void;
    /** 断开由原生辅助进程转交的连接。 */
    dropNative(key: string): void;
    /** 为新连接创建对端状态。 */
    private peer;
    /** 断开连接并把其审计来源退役。 */
    private dropPeer;
    /** 解析并分派一条入站消息：握手、审计帧或控制消息。 */
    private receive;
    /** 转交已校验的事件给宿主事件处理。 */
    private event;
    /** 向对端回复确认或刷新结果帧。 */
    private reply;
    /** 通知对端进入关闭阶段并开始刷新。 */
    private preparePeer;
    /** 这里只准备审计；资源关闭仍由原生命周期负责。 */
    prepareAudit(options: RuntimeAuditCloseOptions): void;
    /** 关闭代理，重复调用返回同一个 Promise。 */
    close(options?: RuntimeAuditCloseOptions): Promise<void>;
    /** 执行实际关闭：刷新各对端、断开连接并清理目录。 */
    private closeOnce;
}
