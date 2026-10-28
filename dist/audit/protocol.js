import { performance } from "node:perf_hooks";
import { types } from "node:util";
import { arrayEach, arrayEvery, arrayIncludes, arrayIsArray, arraySome, bufferByteLength, jsonStringify, mathMax, newSet, numberIsFinite, numberIsSafeInteger, objectBase, objectCreate, objectDefine, objectDescriptor, objectFreeze, objectKeys, objectPrototype, regexpTest, setAdd, setDelete, setHas, } from "../protect/intrinsics.js";
import { M } from "../shared/messages.js";
const isProxy = types.isProxy;
const monotonic = performance.now.bind(performance);
const number = Number;
export const auditProtocol = 1;
export const auditFrameBytes = 65536;
export const auditOrdinaryRecords = 4096;
export const auditOrdinaryBytes = 2 * 1024 * 1024;
export const auditLossReasons = objectFreeze([
    "queue-records",
    "queue-bytes",
    "oversize",
    "serialization",
    "send-error",
    "disconnected",
    "after-seal",
    "sink-error",
    "partial-write",
    "deadline",
    "unsequenced",
    "rejected-frame",
]);
/** 创建各丢失原因均为 0 的计数表。 */
export function auditLossCounts() {
    const result = {};
    arrayEach(auditLossReasons, reason => objectDefine(result, reason, {
        value: 0,
        enumerable: true,
        writable: true,
        configurable: true,
    }));
    return result;
}
/** 创建基于单调时钟的剩余预算计时器。 */
export function createAuditDeadline(budgetMs, now = monotonic) {
    let last = now();
    const end = last + mathMax(0, numberIsFinite(budgetMs) ? budgetMs : 0);
    return objectFreeze({
        remainingMs: () => {
            last = mathMax(last, now());
            return mathMax(0, end - last);
        },
    });
}
/** 创建全零的来源计数器。 */
export function createAuditSourceCounters() {
    return {
        offered: 0,
        accepted: 0,
        sendCompleted: 0,
        hopReceived: 0,
        unknown: 0,
        invalidReplies: 0,
        rejected: auditLossCounts(),
        criticalCoalesced: 0,
        pendingRecords: 0,
        pendingBytes: 0,
        highWaterRecords: 0,
        highWaterBytes: 0,
    };
}
/** 仅复制受限的自有数据；不执行访问器、Proxy 或 SDK 实例代码。 */
export function copyAuditData(value) {
    let nodes = 0;
    let bytes = 0;
    const seen = newSet();
    /** 递归复制为有界纯数据，超出节点或深度上限时抛错。 */
    function copy(input, depth) {
        if (++nodes > 4096 || depth > 10)
            throw new TypeError(M.audit.dataLimit);
        if (input === null || typeof input === "boolean")
            return input;
        if (typeof input === "string") {
            bytes += bufferByteLength(input);
            if (bytes > auditFrameBytes)
                throw new TypeError(M.audit.stringLimit);
            return input;
        }
        if (typeof input === "number" && numberIsFinite(input))
            return input;
        if (input === undefined)
            return undefined;
        if (!input || typeof input !== "object" || isProxy(input) || setHas(seen, input))
            throw new TypeError(M.audit.dataPlain);
        const prototype = objectPrototype(input);
        if (arrayIsArray(input) && input.length > 256)
            throw new TypeError(M.audit.arrayLimit);
        if (!arrayIsArray(input) && prototype !== objectBase() && prototype !== null)
            throw new TypeError(M.audit.dataPlain);
        setAdd(seen, input);
        try {
            const keys = objectKeys(input);
            if (keys.length > 256)
                throw new TypeError(M.audit.propertyLimit);
            const array = arrayIsArray(input);
            const result = array ? [] : objectCreate(null);
            // 遮蔽原型上的 toJSON 和稀疏数组索引，序列化不调用业务钩子。
            if (array)
                objectDefine(result, "toJSON", { value: undefined, configurable: true });
            if (array && keys.length !== input.length)
                for (let index = 0; index < input.length; index++)
                    objectDefine(result, index, {
                        value: null,
                        enumerable: true,
                        configurable: true,
                        writable: true,
                    });
            arrayEach(keys, key => {
                const item = objectDescriptor(input, key);
                bytes += bufferByteLength(key);
                if (key.length > 1024 || bytes > auditFrameBytes)
                    throw new TypeError(M.audit.propertyLimit);
                if (array && !regexpTest(/^(0|[1-9]\d*)$/, key))
                    throw new TypeError(M.audit.arrayProperty);
                if (!("value" in item))
                    throw new TypeError(M.audit.accessor);
                const value = copy(item.value, depth + 1);
                if (array)
                    objectDefine(result, key, {
                        value,
                        enumerable: true,
                        configurable: true,
                        writable: true,
                    });
                else
                    result[key] = value;
            });
            return result;
        }
        finally {
            setDelete(seen, input);
        }
    }
    return copy(value, 0);
}
/** 只序列化已限界的纯数据，不执行继承的 toJSON。 */
export function stringifyAuditData(value) {
    const result = jsonStringify(copyAuditData(value));
    if (typeof result !== "string")
        throw new TypeError(M.audit.serialize);
    return result;
}
/** 判断为不小于下限的安全整数。 */
const integer = (value, minimum = 0) => numberIsSafeInteger(value) && number(value) >= minimum;
/** 判断为合法的通道随机串。 */
const nonce = (value) => typeof value === "string" && regexpTest(/^[a-zA-Z0-9_-]{16,128}$/, value);
/** 校验来源计数器的结构与取值。 */
function counters(value) {
    if (!value || typeof value !== "object" || arrayIsArray(value))
        return false;
    const row = value;
    const names = objectKeys(createAuditSourceCounters());
    if (arraySome(objectKeys(row), key => !arrayIncludes(names, key)))
        return false;
    if (!arrayEvery(names, key => key === "rejected" || integer(row[key])))
        return false;
    if (number(row.accepted) > number(row.offered) ||
        arraySome(["sendCompleted", "hopReceived", "unknown", "pendingRecords"], key => number(row[key]) > number(row.accepted)) ||
        number(row.criticalCoalesced) > number(row.offered) ||
        number(row.pendingRecords) > number(row.highWaterRecords) ||
        number(row.pendingBytes) > number(row.highWaterBytes))
        return false;
    const rejected = row.rejected;
    return !!(rejected &&
        !arrayIsArray(rejected) &&
        objectKeys(rejected).length === auditLossReasons.length &&
        arrayEvery(auditLossReasons, reason => integer(rejected[reason])));
}
/** 验证客体自报快照，不执行访问器，也不保留其对象。 */
export function parseAuditSourceCounters(value) {
    try {
        const snapshot = copyAuditData(value);
        return counters(snapshot) ? snapshot : undefined;
    }
    catch {
        return undefined;
    }
}
/** 仅处理审计；接收端必须另行绑定实际通道和当前代次。 */
export function parseAuditFrame(value) {
    try {
        const row = copyAuditData(value);
        if (!row ||
            arrayIsArray(row) ||
            row.auditProtocol !== auditProtocol ||
            !integer(row.generation, 1) ||
            !nonce(row.channelNonce) ||
            bufferByteLength(jsonStringify(row)) > auditFrameBytes)
            return undefined;
        const common = ["auditProtocol", "generation", "channelNonce", "type", "pid"];
        let fields;
        switch (row.type) {
            case "audit":
            case "violation":
                fields = ["auditSeq", "event"];
                if (!integer(row.auditSeq, 1) || !row.event || typeof row.event !== "object")
                    return undefined;
                if (arrayIsArray(row.event))
                    return undefined;
                break;
            case "audit-hop-ack":
                fields = ["auditSeq", "result"];
                if (!integer(row.auditSeq, 1) || !arrayIncludes(["received", "rejected-frame"], row.result))
                    return undefined;
                break;
            case "audit-prepare-flush":
                fields = ["closeNonce", "remainingBudgetMs", "scope"];
                if (!nonce(row.closeNonce) ||
                    typeof row.remainingBudgetMs !== "number" ||
                    !numberIsFinite(row.remainingBudgetMs) ||
                    row.remainingBudgetMs < 0 ||
                    row.remainingBudgetMs > 120000 ||
                    row.scope !== "this-source-only")
                    return undefined;
                break;
            case "audit-seal":
                fields = ["closeNonce", "lastSentSeq", "sourceCounters", "nestedCoverage"];
                if (!nonce(row.closeNonce) ||
                    !integer(row.lastSentSeq) ||
                    !counters(row.sourceCounters) ||
                    !arrayIncludes(["settled", "incomplete", "unknown"], row.nestedCoverage))
                    return undefined;
                if (number(row.lastSentSeq) > row.sourceCounters.accepted)
                    return undefined;
                break;
            case "audit-flush-result":
                fields = [
                    "closeNonce",
                    "cutoff",
                    "scope",
                    "outcome",
                    "receivedThrough",
                    "settledThrough",
                    "writtenThrough",
                    "writtenCount",
                    "rejectedCount",
                    "unknownCount",
                    "remainingCount",
                    "evidence",
                ];
                if (!nonce(row.closeNonce) ||
                    row.scope !== "this-source-only" ||
                    !arrayIncludes(["all-offered-written", "settled-with-loss", "incomplete"], row.outcome) ||
                    !arrayIncludes(["host-append-completed", "parent-hop-only"], row.evidence) ||
                    !arrayEvery([
                        "cutoff",
                        "receivedThrough",
                        "settledThrough",
                        "writtenThrough",
                        "writtenCount",
                        "rejectedCount",
                        "unknownCount",
                        "remainingCount",
                    ], key => integer(row[key])) ||
                    number(row.writtenThrough) > number(row.settledThrough) ||
                    number(row.settledThrough) > number(row.receivedThrough) ||
                    number(row.receivedThrough) > number(row.cutoff))
                    return undefined;
                if (arraySome(["writtenCount", "rejectedCount", "remainingCount"], key => number(row[key]) > number(row.cutoff)))
                    return undefined;
                if (row.outcome === "all-offered-written" &&
                    (row.evidence !== "host-append-completed" ||
                        row.writtenThrough !== row.cutoff ||
                        row.writtenCount !== row.cutoff ||
                        row.rejectedCount !== 0 ||
                        row.unknownCount !== 0 ||
                        row.remainingCount !== 0))
                    return undefined;
                break;
            default:
                return undefined;
        }
        if (arraySome(objectKeys(row), key => !arrayIncludes(common, key) && !arrayIncludes(fields, key)))
            return undefined;
        delete row.pid;
        return row;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=protocol.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("audit/protocol.ts", { auditProtocol, auditFrameBytes, auditOrdinaryRecords, auditOrdinaryBytes, auditLossReasons, auditLossCounts, createAuditDeadline, createAuditSourceCounters, copyAuditData, stringifyAuditData, parseAuditSourceCounters, parseAuditFrame })
