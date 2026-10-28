export interface CanonicalSnapshot {
    protocol: 1;
    enabled: boolean;
    disabled: boolean;
    offered: number;
    acceptedRoot: number;
    completed: number;
    rejected: number;
    unsupported: number;
    timedOut: number;
    unknown: number;
}
export interface CanonicalStats {
    scope: "canonical-metadata-only";
    provenance: "native-broker-reported";
    capabilityRequested: boolean;
    reports: {
        ready: boolean;
        exit: boolean;
        cleanup: boolean;
        invalid: number;
    };
    latestStage?: "ready" | "exit" | "cleanup";
    snapshot?: CanonicalSnapshot;
    cleanupConfirmed?: boolean;
    cleanupUnknown: boolean;
    finalSnapshotMissing: boolean;
    nativeExit?: {
        code: number | null;
        signal: NodeJS.Signals | null;
    };
    nativeOutputClosed: boolean;
    /** 进程退出仅证明系统回收完成，不证明元数据查询完成。 */
    nativeHelperResourcesReleased: boolean;
}
/** 每个观察器只属于一个原生 broker 进程。 */
export interface CanonicalObserver {
    invalid(stage?: "ready" | "exit" | "cleanup"): boolean;
    record(stage: "ready" | "exit" | "cleanup", raw: unknown, cleanupConfirmed?: unknown): boolean;
    nativeExit(code: number | null, signal: NodeJS.Signals | null): void;
    outputClosed(): void;
    stats(): CanonicalStats;
}
/** 这些计数只统计原生操作和连接，不统计审计记录或追加次数。 */
export declare function createCanonicalObserver(capabilityRequested: boolean): CanonicalObserver;
export interface TransportCounters {
    scope: "windows-broker-transport-only";
    evidence: "transport-callback-and-forwarding-only";
    control: {
        offered: number;
        accepted: number;
        completed: number;
        rejected: number;
        unknown: number;
        closed: number;
    };
    output: {
        offeredBytes: number;
        forwardedBytes: number;
        droppedBytes: number;
        unknownBytes: number;
    };
    native: {
        closed: number;
        rejected: number;
        unknown: number;
    };
}
/** 创建全零的传输计数。 */
export declare function createTransportCounters(): TransportCounters;
/** 饱和累加计数。 */
export declare function addCounter(value: number, amount?: number): number;
