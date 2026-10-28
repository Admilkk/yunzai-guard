import type { EmitEvent, GuardSettings } from "../shared/types.js";
import { type AuditDeadline } from "../audit/protocol.js";
export declare const workerMetadataKey = "yunzai.guard.runtime.bootstrap.v1";
export declare const runtimeKey: unique symbol;
export interface RuntimeIdentity {
    id: string;
    parentId?: string;
    kind: "yunzai" | "node-process" | "thread";
    generation: number;
    pid: number;
    threadId?: number;
    originPlugin: string;
    observability: "js-entrypoints";
}
export interface WorkerMonitorOptions {
    settings: GuardSettings;
    identity: RuntimeIdentity;
    manifestPath?: string;
    resolutionManifestPath?: string;
    emit: EmitEvent;
    originPlugin: () => string | undefined;
}
export interface WorkerAuditCloseOptions {
    deadline: AuditDeadline;
    nonce: string;
}
export interface WorkerAuditCoverage {
    nestedCoverage: "settled" | "incomplete" | "unknown";
    evidence: "parent-hop-only";
    activeSources: number;
    sealedSources: number;
    incompleteSources: number;
    invalidFrames: number;
    untrackedSources: number;
    guestReportedCounters: true;
}
export type WorkerMonitorHandle = (() => void) & {
    prepareAudit(options: WorkerAuditCloseOptions): void;
    auditCoverage(): WorkerAuditCoverage;
};
/** 通过 environmentData 传递专用端口，不修改业务 workerData/parentPort。 */
export declare function installWorkerMonitor(options: WorkerMonitorOptions): WorkerMonitorHandle;
