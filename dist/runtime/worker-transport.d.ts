import net from "node:net";
export interface WorkerTransportCounters {
    scope: "worker-to-native-control-only";
    evidence: "transport-callback-only";
    provenance: "guest-reported";
    offered: number;
    accepted: number;
    completed: number;
    rejected: number;
    unknown: number;
    closed: number;
}
/** 创建全零的线程传输计数。 */
export declare function createWorkerTransportCounters(): WorkerTransportCounters;
/** 返回已安装的传输计数副本。 */
export declare function workerTransportStats(): WorkerTransportCounters | undefined;
/** 计数包含管理和业务帧，不能与审计记录计数相加。 */
export declare function workerTransportIsIncomplete(counters: WorkerTransportCounters): boolean;
/** 在进入实际队列前拒绝超限字节，同时保留 write 的布尔值和回调。 */
export declare function writeWorkerControlFrame(socket: Pick<net.Socket, "writable" | "destroyed" | "writableLength" | "write">, connected: boolean, message: unknown, counters: WorkerTransportCounters, callback?: (error?: Error | null) => void): boolean;
/** Windows AppContainer 使用经 Job 校验的命名管道，不继承 Node 原生 IPC。 */
export declare function ensureWorkerTransport(): Promise<void>;
