const canonicalCounterNames = [
    "offered",
    "acceptedRoot",
    "completed",
    "rejected",
    "unsupported",
    "timedOut",
    "unknown",
];
/** 这些计数只统计原生操作和连接，不统计审计记录或追加次数。 */
export function createCanonicalObserver(capabilityRequested) {
    const ranks = { ready: 1, exit: 2, cleanup: 3 };
    const snapshots = {};
    const state = {
        scope: "canonical-metadata-only",
        provenance: "native-broker-reported",
        capabilityRequested,
        reports: { ready: false, exit: false, cleanup: false, invalid: 0 },
        cleanupUnknown: false,
        finalSnapshotMissing: false,
        nativeOutputClosed: false,
        nativeHelperResourcesReleased: false,
    };
    const invalid = () => {
        state.reports.invalid = addCounter(state.reports.invalid);
        return false;
    };
    return {
        /** 标记诊断记录无效。 */
        invalid(stage) {
            if (stage === "cleanup")
                state.cleanupUnknown = true;
            return invalid();
        },
        /** 记录辅助程序在某阶段的诊断输出。 */
        record(stage, raw, cleanupConfirmed) {
            const reject = () => {
                if (stage === "cleanup")
                    state.cleanupUnknown = true;
                return invalid();
            };
            if (!raw || typeof raw !== "object" || Array.isArray(raw))
                return reject();
            const value = raw;
            const keys = Object.keys(value);
            if (keys.length !== 10 ||
                keys.some(key => !["protocol", "enabled", "disabled", ...canonicalCounterNames].includes(key)) ||
                value.protocol !== 1 ||
                value.enabled !== capabilityRequested ||
                typeof value.disabled !== "boolean" ||
                canonicalCounterNames.some(key => !Number.isSafeInteger(value[key]) || Number(value[key]) < 0) ||
                Number(value.acceptedRoot) > 1 ||
                Number(value.acceptedRoot) > Number(value.offered) ||
                (!capabilityRequested &&
                    (value.disabled !== true || canonicalCounterNames.some(key => value[key] !== 0))) ||
                (stage === "cleanup" && typeof cleanupConfirmed !== "boolean") ||
                (stage !== "cleanup" && cleanupConfirmed !== undefined) ||
                state.reports[stage])
                return reject();
            for (const [otherStage, other] of Object.entries(snapshots)) {
                // stdout 与原 stderr 之间没有投递顺序保证；核验
                // 逻辑阶段的单调性，并保留最新的逻辑快照。
                const earlier = ranks[otherStage] < ranks[stage] ? other : value;
                const later = earlier === other ? value : other;
                if ((earlier.disabled && !later.disabled) ||
                    canonicalCounterNames.some(key => Number(earlier[key]) > Number(later[key])))
                    return reject();
            }
            state.reports[stage] = true;
            snapshots[stage] = {
                protocol: 1,
                enabled: capabilityRequested,
                disabled: value.disabled,
                ...Object.fromEntries(canonicalCounterNames.map(key => [key, Number(value[key])])),
            };
            if (!state.latestStage || ranks[stage] > ranks[state.latestStage]) {
                state.latestStage = stage;
                state.snapshot = snapshots[stage];
            }
            if (stage === "cleanup") {
                state.cleanupConfirmed = cleanupConfirmed;
                if (!cleanupConfirmed)
                    state.cleanupUnknown = true;
            }
            return true;
        },
        /** 记录辅助程序的退出码与信号。 */
        nativeExit(code, signal) {
            state.nativeExit = { code, signal };
            state.nativeHelperResourcesReleased = true;
        },
        /** 标记辅助程序输出已关闭。 */
        outputClosed() {
            state.nativeOutputClosed = true;
            state.finalSnapshotMissing = !state.reports.cleanup;
            if (state.finalSnapshotMissing)
                state.cleanupUnknown = true;
        },
        stats: () => structuredClone(state),
    };
}
/** 创建全零的传输计数。 */
export function createTransportCounters() {
    return {
        scope: "windows-broker-transport-only",
        evidence: "transport-callback-and-forwarding-only",
        control: { offered: 0, accepted: 0, completed: 0, rejected: 0, unknown: 0, closed: 0 },
        output: { offeredBytes: 0, forwardedBytes: 0, droppedBytes: 0, unknownBytes: 0 },
        native: { closed: 0, rejected: 0, unknown: 0 },
    };
}
/** 饱和累加计数。 */
export function addCounter(value, amount = 1) {
    return Math.min(Number.MAX_SAFE_INTEGER, value + amount);
}
//# sourceMappingURL=diagnostics.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../../protect/objects.js"
__guardRegisterExports("sandbox/windows/diagnostics.ts", { createCanonicalObserver, createTransportCounters, addCounter })
