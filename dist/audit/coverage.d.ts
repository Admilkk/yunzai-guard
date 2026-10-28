import type { AuditReceiver } from "./receiver.js";
export type AuditCoverage = ReturnType<AuditReceiver["stats"]>;
export type AuditCoverageStage = "generation-close" | "host-stop";
interface CoverageRecord {
    type: string;
    details: Record<string, unknown>;
}
/** 扁平宿主快照避免通用深度及数组截断；已退役对端仅保留汇总。 */
export declare function auditCoverageRecords(coverage: AuditCoverage, stage: AuditCoverageStage): Generator<CoverageRecord>;
export {};
