/** 扁平宿主快照避免通用深度及数组截断；已退役对端仅保留汇总。 */
export function* auditCoverageRecords(coverage, stage) {
    const common = { generation: coverage.generation, stage };
    yield {
        type: "audit-coverage-summary",
        details: {
            ...common,
            invalidFrames: coverage.invalidFrames,
            activeSources: coverage.sources.length,
            retiredSources: coverage.retired.sources,
            sourceIdentity: "host-channel-id-within-generation",
            retiredDetail: "aggregate-only",
            evidence: "host-observed-coverage-snapshot",
            retention: "subject-to-sink-rotation-and-write-outcome",
        },
    };
    yield {
        type: "audit-retired-summary",
        details: {
            ...common,
            sources: coverage.retired.sources,
            sealed: coverage.retired.sealed,
            missingSeal: coverage.retired.missingSeal,
            written: coverage.retired.written,
            rejected: coverage.retired.rejected,
            unknown: coverage.retired.unknown,
            sourceRejected: coverage.retired.sourceRejected,
            sourceCoalesced: coverage.retired.sourceCoalesced,
            sourcePendingRecords: coverage.retired.sourcePendingRecords,
            allOfferedWritten: coverage.retired.allOfferedWritten,
            settledWithLoss: coverage.retired.settledWithLoss,
            incomplete: coverage.retired.incomplete,
        },
    };
    for (const source of coverage.sources)
        yield {
            type: "audit-source-summary",
            details: {
                ...common,
                sourceId: source.sourceId,
                transport: source.transport,
                received: source.received,
                receivedThrough: source.receivedThrough,
                written: source.written,
                rejected: source.rejected,
                unknown: source.unknown,
                sourceUnknown: source.sourceLoss.unknown,
                sourceRejected: source.sourceLoss.rejected,
                sourceCoalesced: source.sourceLoss.coalesced,
                sourcePendingRecords: source.sourceLoss.pendingRecords,
                transportUnknown: source.transportUnknown,
                transportCounterUnit: "channel-incidents-not-records",
                pending: source.pending,
                sealed: source.sealed,
                bookkeepingRanges: source.bookkeepingRanges,
                deadlineExceeded: source.deadlineExceeded,
                receiptDelivery: source.receiptDelivery,
                outcome: source.outcome,
                nestedCoverage: source.nestedCoverage,
                evidence: source.evidence,
                dropped: source.dropped,
            },
        };
}
//# sourceMappingURL=coverage.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("audit/coverage.ts", { auditCoverageRecords })
