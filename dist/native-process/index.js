import { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { types } from "node:util";
import { nativeIdentityLimits, NativeIdentityError } from "./protocol.js";
import { fail, object, keys, integer, token, equal, remaining, profile, refusalCodes, parseNativeIdentity, } from "./validation.js";
import { hashFile } from "./bundle.js";
import { Transport } from "./transport.js";
// 公开入口保持稳定；协议、验证及传输由各模块独立负责。
export * from "./protocol.js";
export { parseNativeIdentity, parseNativeIdentityJson } from "./validation.js";
/** 按预算计算截止时间，预算受上限约束。 */
function budgetDeadline(budget) {
    return performance.now() + integer(budget, nativeIdentityLimits.maximumBudgetMs);
}
/** 校验并复制一条进程捕获记录。 */
function record(value) {
    const item = object(value);
    keys(item, ["recordId", "identity", "parentPid"]);
    return {
        recordId: token(item.recordId),
        identity: parseNativeIdentity(item.identity),
        parentPid: integer(item.parentPid, 2147483647),
    };
}
/** 确认捕获记录形成以根进程为起点的树。 */
function rootRecords(records, root) {
    const byPid = new Map(), ids = new Set();
    for (const row of records) {
        if (row.identity.pid === root.pid ||
            byPid.has(row.identity.pid) ||
            ids.has(row.recordId) ||
            row.identity.birth.kind !== "windows-filetime-100ns")
            fail("IDENTITY_UNKNOWN");
        byPid.set(row.identity.pid, row);
        ids.add(row.recordId);
    }
    for (const row of records) {
        let current = row;
        const seen = new Set();
        while (true) {
            if (seen.has(current.identity.pid))
                fail("IDENTITY_UNKNOWN");
            seen.add(current.identity.pid);
            const parent = current.parentPid === root.pid ? root : byPid.get(current.parentPid)?.identity;
            if (!parent || BigInt(current.identity.birth.value) < BigInt(parent.birth.value))
                fail("IDENTITY_UNKNOWN");
            if (parent.pid === root.pid)
                break;
            current = byPid.get(parent.pid);
        }
    }
}
class RootSession {
    root;
    binding;
    probe;
    transport;
    captureRetired = false;
    committed = new Set();
    captureSerial = 0;
    /** 创建原进程捕获会话。 */
    constructor(root, binding, probe, transport) {
        this.root = root;
        this.binding = binding;
        this.probe = probe;
        this.transport = transport;
    }
    /** 停止接受新的捕获。 */
    retireCapture() {
        this.captureRetired = true;
        this.probe.retire();
    }
    /** 把原进程树的子进程记录到账本中。 */
    async captureInto(ledger) {
        const incomplete = (reason, count = 1) => ({
            observation: "incomplete",
            committed: false,
            unknownCount: count,
            records: [],
            reason,
        });
        if (this.captureRetired)
            return incomplete("ROOT_OR_PARENT_CHANGED");
        const before = this.probe.probeOriginalNow();
        if (!before.live) {
            this.captureRetired = true;
            return incomplete("ROOT_OR_PARENT_CHANGED");
        }
        let reply;
        try {
            reply = await this.transport.request("capture-root", {
                rootBindingToken: this.binding,
                hostProbeSerial: before.probeSerial,
            });
        }
        catch (error) {
            this.captureRetired = true;
            if (error instanceof NativeIdentityError)
                return incomplete(error.code);
            throw error;
        }
        this.transport.assertReply(reply, "root-captured", [
            "rootBindingToken",
            "root",
            "captureSerial",
            "records",
            "observation",
            "unknownCount",
        ]);
        const after = this.probe.probeOriginalNow();
        if (!after.live) {
            this.captureRetired = true;
            return incomplete("ROOT_OR_PARENT_CHANGED");
        }
        let records;
        try {
            this.transport.validate(() => {
                if (reply.rootBindingToken !== this.binding ||
                    !equal(parseNativeIdentity(reply.root), this.root) ||
                    !Number.isSafeInteger(reply.unknownCount) ||
                    Number(reply.unknownCount) < 0 ||
                    !Array.isArray(reply.records) ||
                    reply.records.length > nativeIdentityLimits.scopeEntries ||
                    !["complete", "incomplete"].includes(String(reply.observation)))
                    fail("IDENTITY_UNKNOWN");
                const captureSerial = integer(reply.captureSerial);
                if (captureSerial <= this.captureSerial)
                    fail("IDENTITY_UNKNOWN");
                this.captureSerial = captureSerial;
                records = reply.records.map(record);
                if (reply.observation === "complete" && reply.unknownCount === 0)
                    rootRecords(records, this.root);
            });
        }
        catch {
            this.transport.invalidate();
            return incomplete("IDENTITY_UNKNOWN");
        }
        if (reply.observation !== "complete" || reply.unknownCount !== 0)
            return incomplete("IDENTITY_UNKNOWN", Math.max(1, Number(reply.unknownCount)));
        const commit = ledger.commitVerifiedSnapshot;
        if (types.isProxy(commit) || types.isAsyncFunction(commit))
            fail("STATE_OR_REQUEST_INVALID");
        // 从上面的原始 native0 调用到此次提交之间不得插入 await。
        const result = Reflect.apply(commit, ledger, [this.root, records]);
        if (result &&
            typeof result === "object" &&
            typeof result.then === "function")
            fail("STATE_OR_REQUEST_INVALID");
        for (const row of records)
            this.committed.add(row.recordId);
        return { observation: "complete", committed: true, unknownCount: 0, records: records };
    }
    /** 终止已捕获的进程，返回结果。 */
    async terminateCaptured(recordIds) {
        this.retireCapture();
        if (!recordIds.length ||
            recordIds.length > nativeIdentityLimits.scopeEntries ||
            new Set(recordIds).size !== recordIds.length ||
            recordIds.some(id => !this.committed.has(id)))
            fail("STATE_OR_REQUEST_INVALID", "refused-before-action");
        const reply = await this.transport.request("terminate-captured", {
            rootBindingToken: this.binding,
            recordIds,
        });
        this.transport.assertReply(reply, "captured-terminated", ["rootBindingToken", "results"]);
        const results = this.transport.validate(() => {
            if (reply.rootBindingToken !== this.binding ||
                !Array.isArray(reply.results) ||
                reply.results.length !== recordIds.length)
                fail();
            const results = reply.results.map(value => {
                const item = object(value);
                keys(item, ["recordId", "result"], ["systemCode"]);
                const id = token(item.recordId);
                if (!recordIds.includes(id) ||
                    !["original-exited", "terminated-and-exited", "identity-changed", "unknown"].includes(String(item.result)) ||
                    (item.systemCode !== undefined && !Number.isSafeInteger(item.systemCode)))
                    fail();
                return item;
            });
            if (new Set(results.map(item => item.recordId)).size !== recordIds.length)
                fail();
            return results;
        });
        return { type: "captured-terminated", rootBindingToken: this.binding, results };
    }
    /** 关闭捕获会话。 */
    close() {
        this.retireCapture();
        return this.transport.close();
    }
}
class InspectorSession {
    parent;
    binding;
    activationAvailable;
    activationProfile;
    unavailableReason;
    transport;
    attempted = false;
    connectionSerial = 0;
    activationUnknown = false;
    /** 创建 PM2 Inspector 父进程会话。 */
    constructor(parent, binding, activationAvailable, activationProfile, unavailableReason, transport) {
        this.parent = parent;
        this.binding = binding;
        this.activationAvailable = activationAvailable;
        this.activationProfile = activationProfile;
        this.unavailableReason = unavailableReason;
        this.transport = transport;
    }
    /** 激活父进程 Inspector，只允许尝试一次。 */
    async activateOnce() {
        if (this.attempted)
            fail("ACTIVATION_ALREADY_ATTEMPTED", "refused-before-action");
        if (!this.activationAvailable)
            fail(this.unavailableReason ?? "UNSUPPORTED_NODE_PROFILE", "refused-before-action");
        this.attempted = true;
        try {
            const reply = await this.transport.request("activate-inspector-once", {
                parentBindingToken: this.binding,
            });
            this.transport.assertReply(reply, "inspector-activated", [
                "parentBindingToken",
                "actionSerial",
                "originalParent",
                "result",
            ]);
            this.transport.validate(() => {
                if (reply.parentBindingToken !== this.binding ||
                    !equal(parseNativeIdentity(reply.originalParent), this.parent) ||
                    !["native-action-completed", "started-unconfirmed"].includes(String(reply.result)))
                    fail();
                integer(reply.actionSerial);
            });
            this.activationUnknown = reply.result === "started-unconfirmed";
            return reply;
        }
        catch (error) {
            this.activationUnknown = true;
            throw error;
        }
    }
    /** 在 WebSocket 连接后确认父进程身份未变。 */
    async confirmAfterWebSocket(serial) {
        integer(serial);
        if (serial <= this.connectionSerial || this.activationUnknown)
            fail("STATE_OR_REQUEST_INVALID");
        const reply = await this.transport.request("confirm-inspector-parent", {
            parentBindingToken: this.binding,
            connectionSerial: serial,
        });
        this.transport.assertReply(reply, "inspector-parent-confirmed", [
            "parentBindingToken",
            "connectionSerial",
            "parent",
            "originalLive",
        ]);
        this.transport.validate(() => {
            if (reply.parentBindingToken !== this.binding ||
                reply.connectionSerial !== serial ||
                reply.originalLive !== true ||
                !equal(parseNativeIdentity(reply.parent), this.parent))
                fail("ROOT_OR_PARENT_CHANGED");
        });
        this.connectionSerial = serial;
        return reply;
    }
    /** 关闭会话。 */
    close() {
        return this.transport.close();
    }
}
/** 仅供宿主使用的适配器；原生操作绝不回退到数字 PID API。 */
export function createNativeIdentityAdapter(options = {}) {
    return {
        /** 启动辅助程序并核验根进程身份。 */
        async openRoot(probe, budget) {
            const deadline = budgetDeadline(budget), before = probe.probeOriginalNow();
            if (!before.live)
                fail("ROOT_OR_PARENT_CHANGED", "refused-before-action");
            const transport = new Transport(options, deadline);
            try {
                const reply = await transport.request("open-root", {
                    rootPid: probe.pid,
                    sessionBudgetMs: remaining(deadline),
                });
                transport.assertReply(reply, "root-ready", [
                    "rootBindingToken",
                    "root",
                    "caller",
                    "nativeRelation",
                ]);
                const root = parseNativeIdentity(reply.root), caller = parseNativeIdentity(reply.caller), after = probe.probeOriginalNow();
                if (!after.live ||
                    root.pid !== probe.pid ||
                    caller.pid !== process.pid ||
                    root.birth.kind !== "windows-filetime-100ns" ||
                    caller.birth.kind !== "windows-filetime-100ns" ||
                    BigInt(root.birth.value) < BigInt(caller.birth.value) ||
                    reply.nativeRelation !== "caller-direct-child")
                    fail("ROOT_OR_PARENT_CHANGED");
                return new RootSession(root, token(reply.rootBindingToken), probe, transport);
            }
            catch (error) {
                await transport.close().catch(() => { });
                throw error;
            }
        },
        /** 打开 PM2 父进程的 Inspector 会话。 */
        async openInspectorParent({ expectedParent, remainingBudgetMs }) {
            const deadline = budgetDeadline(remainingBudgetMs), transport = new Transport(options, deadline);
            try {
                if (expectedParent)
                    parseNativeIdentity(expectedParent);
                const reply = await transport.request("open-inspector-parent", {
                    sessionBudgetMs: remaining(deadline),
                    ...(expectedParent ? { expectedParent } : {}),
                });
                transport.assertReply(reply, "inspector-parent-ready", ["parentBindingToken", "caller", "parent", "activationAvailable"], ["activationProfile", "unavailableReason"]);
                const caller = parseNativeIdentity(reply.caller), parent = parseNativeIdentity(reply.parent);
                if (caller.pid !== process.pid ||
                    (expectedParent && !equal(parent, expectedParent)) ||
                    parent.birth.kind !== caller.birth.kind ||
                    BigInt(parent.birth.value) > BigInt(caller.birth.value) ||
                    typeof reply.activationAvailable !== "boolean")
                    fail("ROOT_OR_PARENT_CHANGED");
                const qualified = reply.activationProfile === undefined ? undefined : profile(reply.activationProfile);
                const reason = reply.unavailableReason === undefined
                    ? undefined
                    : reply.unavailableReason;
                if ((reason !== undefined && !refusalCodes.has(reason)) ||
                    (reply.activationAvailable && (!qualified || reason)) ||
                    (!reply.activationAvailable && !reason))
                    fail();
                return new InspectorSession(parent, token(reply.parentBindingToken), reply.activationAvailable, qualified, reason, transport);
            }
            catch (error) {
                await transport.close().catch(() => { });
                throw error;
            }
        },
    };
}
const qualifiedProbeImage = "d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5";
let probeRuntimeQualified;
/** 仅检查宿主是否符合条件，不打开、探测或向子进程发送信号。 */
export function assertOriginalWindowsChildProbeRuntime() {
    if (process.platform !== "win32" || process.arch !== "x64" || process.version !== "v24.22.1")
        fail("UNSUPPORTED_NODE_PROFILE", "refused-before-action");
    probeRuntimeQualified ??= hashFile(process.execPath) === qualifiedProbeImage;
    if (!probeRuntimeQualified)
        fail("UNSUPPORTED_NODE_PROFILE", "refused-before-action");
}
/** 受信 spawn 后立即同步调用，必须早于首次 await。 */
export function createOriginalWindowsChildProbe(child) {
    if (process.platform !== "win32" || process.arch !== "x64" || process.version !== "v24.22.1")
        fail("UNSUPPORTED_NODE_PROFILE", "refused-before-action");
    if (types.isProxy(child) || !(child instanceof ChildProcess))
        fail("IDENTITY_UNKNOWN");
    const data = (value, key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && "value" in descriptor ? descriptor.value : undefined;
    };
    const pid = integer(data(child, "pid"), 2147483647), receiver = data(child, "_handle");
    if (!receiver || typeof receiver !== "object" || types.isProxy(receiver))
        fail("UNSUPPORTED_NODE_PROFILE");
    const prototype = Object.getPrototypeOf(receiver);
    const method = data(receiver, "kill") ?? (prototype && data(prototype, "kill"));
    if (typeof method !== "function" || types.isProxy(method))
        fail("UNSUPPORTED_NODE_PROFILE");
    // 同步执行一次性可执行文件资格检查前，先捕获原生接收器。
    assertOriginalWindowsChildProbeRuntime();
    let serial = 0, retired = false;
    return {
        pid,
        /** 退役会话。 */
        retire() {
            retired = true;
        },
        /** 立即复查原进程身份。 */
        probeOriginalNow() {
            if (retired ||
                data(child, "_handle") !== receiver ||
                data(child, "killed") !== false ||
                data(child, "exitCode") !== null ||
                data(child, "signalCode") !== null)
                return { live: false, reason: "original-native-handle-unavailable" };
            try {
                return Reflect.apply(method, receiver, [0]) === 0
                    ? { live: true, probeSerial: ++serial }
                    : { live: false, reason: "original-native-handle-not-live" };
            }
            catch {
                return { live: false, reason: "original-native-handle-probe-failed" };
            }
        },
    };
}
//# sourceMappingURL=index.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("native-process/index.ts", { createNativeIdentityAdapter, assertOriginalWindowsChildProbeRuntime, createOriginalWindowsChildProbe })
