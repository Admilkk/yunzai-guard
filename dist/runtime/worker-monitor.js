import workerThreads, { MessageChannel, getEnvironmentData, receiveMessageOnPort, setEnvironmentData, } from "node:worker_threads";
import { randomBytes, randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { monitoredExecArgv } from "./launch.js";
import { evaluatePolicy, GuardDeniedError } from "../config/policy.js";
import { runtimeEventDecision, runtimeFailureDecision } from "./policy.js";
import { arrayIsArray, arrayMap, arrayEvery, arrayPush, objectDefine, stringSlice, } from "../protect/intrinsics.js";
import { auditProtocol, parseAuditFrame, } from "../audit/protocol.js";
export const workerMetadataKey = "yunzai.guard.runtime.bootstrap.v1";
export const runtimeKey = Symbol.for("yunzai.guard.runtime.v1");
const construct = Reflect.construct;
const Channel = MessageChannel;
const getData = getEnvironmentData;
const setData = setEnvironmentData;
/** 通过 environmentData 传递专用端口，不修改业务 workerData/parentPort。 */
export function installWorkerMonitor(options) {
    const deliver = (event) => {
        try {
            options.emit(event);
            return true;
        }
        catch {
            // 可选审计投递不能改变业务 Worker API 行为。
            return false;
        }
    };
    const emit = event => {
        deliver(event);
    };
    const OriginalWorker = workerThreads.Worker;
    const originalDescriptor = Object.getOwnPropertyDescriptor(workerThreads, "Worker");
    const pending = new Set();
    const auditSources = new Set();
    let auditClose;
    let sealedSources = 0;
    let incompleteSources = 0;
    let invalidFrames = 0;
    let untrackedSources = 0;
    let stopped = false;
    const WrappedWorker = new Proxy(OriginalWorker, {
        /** 构造 Worker 前注入运行时元数据与审计端口。 */
        construct(target, args, newTarget) {
            const current = args[1];
            if (current !== undefined &&
                (current === null || typeof current !== "object" || arrayIsArray(current)))
                return construct(target, args, newTarget);
            const userOptions = {
                __proto__: null,
                ...current,
            };
            const supplied = userOptions.execArgv === undefined ? process.execArgv : userOptions.execArgv;
            if (!arrayIsArray(supplied))
                return construct(target, [args[0], { ...userOptions, execArgv: supplied }], newTarget);
            const argv = arrayMap(supplied, value => value);
            if (!arrayEvery(argv, value => typeof value === "string"))
                return construct(target, [args[0], { ...userOptions, execArgv: argv }], newTarget);
            const originPlugin = options.originPlugin() ?? options.identity.originPlugin;
            const runtime = {
                id: randomUUID(),
                parentId: options.identity.id,
                kind: "thread",
                generation: options.identity.generation,
                pid: process.pid,
                originPlugin,
                observability: "js-entrypoints",
            };
            const event = {
                kind: "process",
                operation: "worker",
                target: typeof args[0] === "string" && !userOptions?.eval
                    ? stringSlice(args[0], 0, 512)
                    : "worker-script",
                plugin: originPlugin,
            };
            const decision = evaluatePolicy(options.settings, event);
            emit({
                ...event,
                ...decision,
                details: { blocked: decision.action !== "audit", argumentsRedacted: true },
            });
            if (decision.action !== "audit")
                throw new GuardDeniedError("worker", decision.ruleId);
            const channel = new Channel();
            const channelNonce = randomBytes(24).toString("hex");
            const previous = getData(workerMetadataKey);
            let worker;
            try {
                const transferList = [...(userOptions.transferList ?? [])];
                arrayPush(transferList, channel.port2);
                const workerOptions = { ...userOptions, execArgv: monitoredExecArgv(argv), transferList };
                setData(workerMetadataKey, {
                    version: 1,
                    identity: runtime,
                    settings: options.settings,
                    manifestPath: options.manifestPath,
                    resolutionManifestPath: options.resolutionManifestPath,
                    port: channel.port2,
                    auditChannelNonce: channelNonce,
                });
                worker = construct(target, [args[0], workerOptions], newTarget);
            }
            catch (error) {
                channel.port1.close();
                channel.port2.close();
                throw error;
            }
            finally {
                setData(workerMetadataKey, previous);
            }
            let ready = false;
            let failureReported = false;
            let lastSequence = 0;
            let contiguousSequence = 0;
            let seal;
            let prepared;
            let sourceIncomplete = false;
            const source = {
                /** 通知线程进入关闭阶段。 */
                prepare(close) {
                    if (prepared || seal)
                        return;
                    prepared = close;
                    try {
                        channel.port1.postMessage({
                            type: "audit-prepare-flush",
                            auditProtocol,
                            generation: runtime.generation,
                            channelNonce,
                            closeNonce: close.nonce,
                            remainingBudgetMs: Math.min(120000, Math.max(0, close.deadline.remainingMs())),
                            scope: "this-source-only",
                        });
                    }
                    catch {
                        sourceIncomplete = true;
                    }
                },
                sealed: () => Boolean(seal && !sourceIncomplete),
            };
            // 限制关闭阶段的登记规模，不改变业务 Worker API。
            const tracked = auditSources.size < 128;
            if (tracked)
                auditSources.add(source);
            else
                untrackedSources++;
            if (auditClose)
                source.prepare(auditClose);
            const observedThreadId = worker.threadId;
            const failed = (reason) => {
                const event = {
                    kind: "runtime",
                    operation: "runtime-bootstrap-failed",
                    target: runtime.id,
                    plugin: originPlugin,
                };
                const decision = runtimeFailureDecision(options.settings, event);
                if (!failureReported) {
                    failureReported = true;
                    emit({
                        ...event,
                        ...decision,
                        details: {
                            runtime: { ...runtime, threadId: observedThreadId },
                            reason,
                            monitoring: "degraded",
                            blocked: decision.action !== "audit",
                        },
                    });
                }
                return decision;
            };
            const timer = setTimeout(() => {
                pending.delete(timer);
                if (ready || stopped)
                    return;
                if (failed("startup-timeout").action !== "audit")
                    void worker.terminate().catch(() => { });
            }, options.settings.handshakeTimeout);
            timer.unref();
            pending.add(timer);
            const handleMessage = (message, afterExit = false) => {
                const value = message;
                if (!value || typeof value !== "object")
                    return;
                if (value.type === "runtime-ready") {
                    if (ready)
                        return;
                    if (value.auditProtocol !== auditProtocol ||
                        value.generation !== runtime.generation ||
                        value.channelNonce !== channelNonce) {
                        invalidFrames++;
                        sourceIncomplete = true;
                        return;
                    }
                    ready = true;
                    clearTimeout(timer);
                    pending.delete(timer);
                    emit({
                        kind: "runtime",
                        operation: "worker-runtime-registered",
                        target: runtime.id,
                        plugin: originPlugin,
                        action: "audit",
                        details: { runtime: { ...runtime, threadId: observedThreadId } },
                    });
                    return;
                }
                const frame = parseAuditFrame(value);
                if (!frame ||
                    frame.generation !== runtime.generation ||
                    frame.channelNonce !== channelNonce) {
                    invalidFrames++;
                    sourceIncomplete = true;
                    return;
                }
                if (frame.type === "audit-seal") {
                    if (!prepared ||
                        seal ||
                        frame.closeNonce !== prepared.nonce ||
                        frame.lastSentSeq !== lastSequence) {
                        invalidFrames++;
                        sourceIncomplete = true;
                        return;
                    }
                    seal = frame;
                    sourceIncomplete ||=
                        contiguousSequence !== lastSequence ||
                            frame.nestedCoverage !== "settled" ||
                            frame.sourceCounters.unknown !== 0 ||
                            frame.sourceCounters.invalidReplies !== 0 ||
                            frame.sourceCounters.pendingRecords !== 0 ||
                            frame.sourceCounters.criticalCoalesced !== 0 ||
                            frame.sourceCounters.offered !== frame.lastSentSeq ||
                            Object.values(frame.sourceCounters.rejected).some(count => count !== 0);
                    try {
                        channel.port1.postMessage({
                            type: "audit-flush-result",
                            auditProtocol,
                            generation: runtime.generation,
                            channelNonce,
                            closeNonce: prepared.nonce,
                            cutoff: lastSequence,
                            scope: "this-source-only",
                            outcome: "incomplete",
                            receivedThrough: contiguousSequence,
                            settledThrough: contiguousSequence,
                            writtenThrough: 0,
                            writtenCount: 0,
                            rejectedCount: 0,
                            unknownCount: sourceIncomplete ? 1 : 0,
                            remainingCount: 0,
                            evidence: "parent-hop-only",
                        });
                    }
                    catch {
                        // 自然退出后，发送者已消失，但有效封账仍可能在队列中。
                        if (!afterExit)
                            sourceIncomplete = true;
                    }
                    return;
                }
                if ((frame.type !== "audit" && frame.type !== "violation") ||
                    seal ||
                    frame.auditSeq <= lastSequence) {
                    invalidFrames++;
                    sourceIncomplete = true;
                    return;
                }
                if (frame.auditSeq !== lastSequence + 1)
                    sourceIncomplete = true;
                lastSequence = frame.auditSeq;
                if (frame.auditSeq === contiguousSequence + 1)
                    contiguousSequence++;
                const acknowledge = (result) => {
                    try {
                        channel.port1.postMessage({
                            type: "audit-hop-ack",
                            auditProtocol,
                            generation: runtime.generation,
                            channelNonce,
                            auditSeq: frame.auditSeq,
                            result,
                        });
                    }
                    catch {
                        if (!afterExit)
                            sourceIncomplete = true;
                    }
                };
                const reported = frame.event;
                if (!reported ||
                    typeof reported !== "object" ||
                    typeof reported.kind !== "string" ||
                    typeof reported.operation !== "string" ||
                    typeof reported.target !== "string")
                    return acknowledge("rejected-frame");
                try {
                    if (Buffer.byteLength(JSON.stringify(frame)) > 65536)
                        return acknowledge("rejected-frame");
                }
                catch {
                    return acknowledge("rejected-frame");
                }
                if (reported.action !== undefined &&
                    !["audit", "deny", "restart"].includes(String(reported.action)))
                    return acknowledge("rejected-frame");
                if (reported.ruleId !== undefined && typeof reported.ruleId !== "string")
                    return acknowledge("rejected-frame");
                const nested = reported.details?.runtime;
                const source = nested &&
                    typeof nested.id === "string" &&
                    nested.kind === "thread" &&
                    nested.pid === process.pid &&
                    nested.generation === runtime.generation
                    ? {
                        id: nested.id,
                        kind: "thread",
                        pid: process.pid,
                        generation: runtime.generation,
                        ...(Number.isSafeInteger(nested.threadId) ? { threadId: nested.threadId } : {}),
                        originPlugin,
                        observability: "js-entrypoints",
                        forwardedBy: runtime.id,
                    }
                    : { ...runtime, threadId: observedThreadId };
                const event = {
                    kind: reported.kind.slice(0, 64),
                    operation: reported.operation.slice(0, 100),
                    target: reported.target.slice(0, 512),
                    plugin: originPlugin,
                    action: reported.action,
                    ...(typeof reported.ruleId === "string" ? { ruleId: reported.ruleId.slice(0, 100) } : {}),
                    ...(typeof reported.timestamp === "string"
                        ? { timestamp: reported.timestamp.slice(0, 40) }
                        : {}),
                    details: {
                        blocked: reported.details?.blocked === true,
                        ...(typeof reported.details?.result === "string"
                            ? { result: reported.details.result.slice(0, 128) }
                            : {}),
                        argumentsRedacted: reported.details?.argumentsRedacted === true,
                        runtime: source,
                    },
                };
                const decision = runtimeEventDecision(options.settings, event);
                delete event.ruleId;
                const forwarded = deliver({ ...event, ...decision });
                if (!forwarded)
                    sourceIncomplete = true;
                acknowledge(forwarded ? "received" : "rejected-frame");
            };
            channel.port1.on("message", handleMessage);
            channel.port1.unref();
            worker.once("exit", code => {
                clearTimeout(timer);
                pending.delete(timer);
                // Worker 退出与私有 MessagePort 属于不同事件源。
                // 父进程繁忙时，可能先收到退出事件，再处理已入队的 ready/audit 回调。
                // 同步取出消息不会再次触发 message 事件。
                const drainLimit = Math.min(options.settings.audit.maxQueue + 4, 4096);
                let drained = 0;
                try {
                    while (drained < drainLimit) {
                        const queued = receiveMessageOnPort(channel.port1);
                        if (!queued)
                            break;
                        drained++;
                        handleMessage(queued.message, true);
                    }
                    if (drained === drainLimit && receiveMessageOnPort(channel.port1) !== undefined) {
                        sourceIncomplete = true;
                        failed("exit-drain-limit");
                    }
                }
                catch {
                    sourceIncomplete = true;
                    failed("exit-drain-failed");
                }
                channel.port1.close();
                if (tracked)
                    auditSources.delete(source);
                if (seal && !sourceIncomplete)
                    sealedSources++;
                else
                    incompleteSources++;
                emit({
                    kind: "runtime",
                    operation: "worker-runtime-exited",
                    target: runtime.id,
                    plugin: originPlugin,
                    action: "audit",
                    details: {
                        runtime: { ...runtime, threadId: observedThreadId },
                        exitCode: code,
                        audit: {
                            evidence: "parent-hop-only",
                            receivedThrough: contiguousSequence,
                            lastSentSeq: seal?.lastSentSeq,
                            countersProvenance: "guest-reported",
                            sourceCounters: seal?.sourceCounters,
                            complete: Boolean(seal && !sourceIncomplete),
                        },
                    },
                });
                if (!ready && !stopped)
                    failed("thread-exited-before-ready");
            });
            return worker;
        },
    });
    objectDefine(workerThreads, "Worker", { ...originalDescriptor, value: WrappedWorker });
    syncBuiltinESMExports();
    let reportedChange = false;
    const checkTimer = options.settings.protect.enabled && options.settings.protect.monitorInstrumentation
        ? setInterval(() => {
            if (workerThreads.Worker === WrappedWorker) {
                reportedChange = false;
                return;
            }
            if (reportedChange)
                return;
            reportedChange = true;
            const event = {
                kind: "integrity",
                operation: "instrumentation-change",
                target: "worker_threads.Worker",
                plugin: options.originPlugin() ?? options.identity.originPlugin,
                details: { blocked: false, detection: "after-change" },
            };
            const decision = evaluatePolicy(options.settings, event);
            emit({
                ...event,
                ...decision,
                action: decision.ruleId ? decision.action : options.settings.protect.action,
            });
        }, options.settings.protect.intervalMs)
        : undefined;
    checkTimer?.unref();
    const dispose = () => {
        stopped = true;
        if (checkTimer)
            clearInterval(checkTimer);
        for (const timer of pending)
            clearTimeout(timer);
        pending.clear();
        if (workerThreads.Worker === WrappedWorker &&
            Object.getOwnPropertyDescriptor(workerThreads, "Worker")?.configurable)
            Object.defineProperty(workerThreads, "Worker", originalDescriptor);
        syncBuiltinESMExports();
    };
    return Object.assign(dispose, {
        /** 开始关闭全部子线程的审计通道。 */
        prepareAudit(close) {
            if (auditClose)
                return;
            auditClose = close;
            for (const source of auditSources)
                source.prepare(close);
        },
        /** 返回嵌套线程的覆盖状态。 */
        auditCoverage() {
            return {
                nestedCoverage: untrackedSources || incompleteSources
                    ? "unknown"
                    : [...auditSources].some(source => !source.sealed())
                        ? "incomplete"
                        : "settled",
                evidence: "parent-hop-only",
                activeSources: auditSources.size,
                sealedSources,
                incompleteSources,
                invalidFrames,
                untrackedSources,
                guestReportedCounters: true,
            };
        },
    });
}
//# sourceMappingURL=worker-monitor.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("runtime/worker-monitor.ts", { workerMetadataKey, runtimeKey, installWorkerMonitor })
