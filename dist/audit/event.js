import { types } from "node:util";
import { parseAuditSourceCounters } from "./protocol.js";
/** 取有界的普通对象副本，非对象返回 undefined。 */
function data(value) {
    if (!value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        types.isProxy(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        return undefined;
    const result = Object.create(null);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value)))
        if (descriptor.enumerable && "value" in descriptor)
            result[key] = descriptor.value;
    return result;
}
/** 校验并复制 Worker 传输统计。 */
function workerTransport(value) {
    const row = data(value);
    const counts = ["offered", "accepted", "completed", "rejected", "unknown", "closed"];
    if (!row ||
        row.scope !== "worker-to-native-control-only" ||
        row.evidence !== "transport-callback-only" ||
        row.provenance !== "guest-reported" ||
        Object.keys(row).length !== counts.length + 3 ||
        !counts.every(key => Number.isSafeInteger(row[key]) && Number(row[key]) >= 0) ||
        Number(row.accepted) > Number(row.offered) ||
        Number(row.completed) > Number(row.accepted) ||
        Number(row.rejected) > Number(row.offered))
        return undefined;
    return {
        ...row,
        coverage: "prefix-before-summary-send",
        counterUnit: "channel-operations-and-incidents-not-audit-records",
    };
}
/** 校验并复制转发的规范化元数据标记。 */
function relayedCanonicalMetadata(value) {
    const row = data(value);
    const flags = [
        "capabilityRequested",
        "cleanupUnknown",
        "finalSnapshotMissing",
        "nativeOutputClosed",
        "nativeHelperResourcesReleased",
    ];
    if (!row ||
        row.scope !== "canonical-metadata-only" ||
        row.provenance !== "native-broker-reported" ||
        !flags.every(key => typeof row[key] === "boolean"))
        return undefined;
    const result = {
        source: "guest-reported",
        evidence: "native-broker-snapshot-relayed-by-parent",
        scope: "canonical-metadata-only",
    };
    for (const key of flags)
        result[key] = row[key];
    if (typeof row.cleanupConfirmed === "boolean")
        result.reportedCleanupConfirmed = row.cleanupConfirmed;
    if (typeof row.latestStage === "string" && ["ready", "exit", "cleanup"].includes(row.latestStage))
        result.reportedStage = row.latestStage;
    const snapshot = data(row.snapshot);
    const counters = [
        "offered",
        "acceptedRoot",
        "completed",
        "rejected",
        "unsupported",
        "timedOut",
        "unknown",
    ];
    if (snapshot?.protocol === 1 &&
        snapshot.enabled === row.capabilityRequested &&
        typeof snapshot.disabled === "boolean" &&
        counters.every(key => Number.isSafeInteger(snapshot[key]) && Number(snapshot[key]) >= 0) &&
        Number(snapshot.acceptedRoot) <= 1 &&
        Number(snapshot.acceptedRoot) <= Number(snapshot.offered)) {
        result.reportedDisabled = snapshot.disabled;
        result.reportedCounters = Object.fromEntries(counters.map(key => [key, snapshot[key]]));
    }
    return result;
}
/** 保留受限证据标签，省略自由格式参数、SDK 错误及凭据。 */
export function sanitizeAuditEvent(value, redact) {
    const source = data(value);
    if (!source ||
        !["kind", "operation", "target"].every(key => typeof source[key] === "string" && source[key].length <= 4096))
        return undefined;
    const result = {};
    const details = data(source.details);
    if (typeof details?.blocked === "boolean")
        result.blocked = details.blocked;
    for (const key of ["kind", "operation", "target", "plugin", "action", "ruleId", "timestamp"])
        if (typeof source[key] === "string")
            result[key] = redact(source[key]);
    const runtime = data(details?.runtime);
    if (runtime) {
        const known = {};
        for (const key of ["id", "parentId", "kind", "observability"])
            if (typeof runtime[key] === "string")
                known[key] = redact(runtime[key]);
        for (const key of ["pid", "threadId"])
            if (Number.isSafeInteger(runtime[key]) && Number(runtime[key]) >= 0)
                known[key] = runtime[key];
        result.runtime = known;
    }
    const facts = {};
    if (source.operation === "module-function-change" && details?.detection === "after-change") {
        facts.detection = "after-change";
        if (typeof details.reason === "string" &&
            ["added", "removed", "descriptor"].includes(details.reason))
            facts.reason = details.reason;
        if (typeof details.attribution === "string" &&
            ["observed-function", "current-plugin", "unknown"].includes(details.attribution))
            facts.attribution = details.attribution;
    }
    if (source.operation === "module-audit-unavailable" && details?.coverage === "partial") {
        facts.coverage = "partial";
        if (typeof details.reason === "string" &&
            [
                "proxy",
                "property-limit",
                "slot-limit",
                "inspection-limit",
                "uninitialized-export",
                "inspection-failed",
                "report-limit",
                "unsupported-path",
                "unsupported-format",
                "source-unavailable",
                "source-limit",
                "module-limit",
                "instrumentation-failed",
                "installation-limit",
                "installation-failed",
                "cyclic-baseline-deferred",
                "resolution-limit",
                "resolution-unavailable",
                "normalization-failed",
                "export-ownership-unavailable",
            ].includes(details.reason))
            facts.reason = details.reason;
    }
    if (details?.source === "guest-reported" && details.observability === "js-entrypoints") {
        facts.source = "guest-reported";
        facts.observability = "js-entrypoints";
        facts.argumentsRedacted = true;
        if (typeof details.reportedBlocked === "boolean")
            facts.reportedBlocked = details.reportedBlocked;
        const reported = data(details.guestRuntime);
        if (reported &&
            typeof reported.id === "string" &&
            reported.id.length <= 128 &&
            typeof reported.kind === "string" &&
            ["thread", "node-process"].includes(reported.kind)) {
            facts.guestRuntime = {
                id: redact(reported.id),
                kind: reported.kind,
                ...(Number.isSafeInteger(reported.threadId) && Number(reported.threadId) >= 0
                    ? { threadId: reported.threadId }
                    : {}),
            };
        }
    }
    if (details?.phase === "policy")
        facts.phase = "policy";
    if (source.operation === "worker-transport-summary") {
        const transport = workerTransport(details?.transport);
        if (transport)
            facts.transport = transport;
    }
    if (source.kind === "plugin-sandbox" &&
        ["native.process-started", "native.process-closed", "native.cleanup-unconfirmed"].includes(String(source.operation))) {
        const canonical = relayedCanonicalMetadata(details?.windowsCanonical);
        if (canonical)
            facts.windowsCanonical = canonical;
    }
    const audit = data(details?.audit);
    if (source.operation === "worker-runtime-exited" &&
        audit?.evidence === "parent-hop-only" &&
        audit.countersProvenance === "guest-reported") {
        const sourceCounters = parseAuditSourceCounters(audit.sourceCounters);
        const receivedThrough = audit.receivedThrough;
        const lastSentSeq = audit.lastSentSeq;
        if (Number.isSafeInteger(receivedThrough) &&
            Number(receivedThrough) >= 0 &&
            (lastSentSeq === undefined ||
                (Number.isSafeInteger(lastSentSeq) &&
                    Number(lastSentSeq) >= Number(receivedThrough) &&
                    sourceCounters &&
                    Number(lastSentSeq) <= sourceCounters.accepted))) {
            facts.audit = {
                evidence: "parent-hop-only",
                countersProvenance: "guest-reported",
                receivedThrough,
                ...(lastSentSeq === undefined ? {} : { lastSentSeq }),
                ...(sourceCounters ? { sourceCounters } : {}),
                // 这是父进程对客体封账的观察，不是宿主追加落盘的证据。
                reportedComplete: audit.complete === true && lastSentSeq !== undefined && Boolean(sourceCounters),
            };
        }
    }
    if (source.operation === "native.service-error" &&
        details?.phase === "result" &&
        details.result === "error") {
        facts.phase = "result";
        facts.result = "error";
        if (typeof details.code === "string" &&
            /^(?:NATIVE_(?:REDIS|CORE)_DENIED|GUARD_DENIED|SERVICE_ERROR|MEDIA_[A-Z_]{1,40})$/.test(details.code))
            facts.code = details.code;
    }
    if (Object.keys(facts).length)
        result.details = facts;
    return result;
}
//# sourceMappingURL=event.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("audit/event.ts", { sanitizeAuditEvent })
