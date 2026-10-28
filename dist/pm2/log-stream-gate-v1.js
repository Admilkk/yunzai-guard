import fs from "node:fs";
import { createHash } from "node:crypto";
import { EventEmitter, errorMonitor } from "node:events";
import { Readable, Writable } from "node:stream";
import { types } from "node:util";
import { ownData } from "./legacy-sidecar.js";
const gates = new WeakMap();
// 精确匹配 PM2 5.0.0 至 7.x ForkMode 的 Function#toString 函数体。
// 仅统一检出文件的换行符；名称相同或外观相似不能作为证据。
const forkCloseHash = "f2d09af5b2eea323c5010888ae295d00f6a664e659c9feb9ce8ae7bf0590575c";
const toString = Function.prototype.toString;
/** 返回子进程的日志门控。 */
export function pm2LogGateFor(child) {
    return gates.get(child);
}
/** 在 PM2 现有三倍 kill_timeout 失败预算内预留余量。 */
export function pm2LogDrainTimeout(killTimeout) {
    const kill = typeof killTimeout === "number" && Number.isFinite(killTimeout)
        ? Math.max(1, killTimeout)
        : 1600;
    return Math.max(1, Math.min(5000, Math.floor(kill / 2)));
}
/** 判断为普通数据记录。 */
function dataRecord(value) {
    return Boolean(value &&
        typeof value === "object" &&
        !types.isProxy(value) &&
        [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}
/** 判断日志路径是否一致。 */
function samePaths(value, expected) {
    if (!dataRecord(value))
        return false;
    const keys = Reflect.ownKeys(value);
    const expectedKeys = Reflect.ownKeys(expected);
    return (keys.length === expectedKeys.length &&
        keys.every(key => typeof key === "string" &&
            expectedKeys.includes(key) &&
            ownData(value, key) === expected[key]));
}
/** 判断为原生文件写入流。 */
function nativeWriter(value) {
    return Boolean(value &&
        typeof value === "object" &&
        !types.isProxy(value) &&
        Object.getPrototypeOf(value) === fs.WriteStream.prototype &&
        !Object.hasOwn(value, "end") &&
        !Object.hasOwn(value, "destroy") &&
        value.end === Writable.prototype.end);
}
/** 判断日志是否被禁用。 */
function disabledLog(value) {
    return (!value || (typeof value === "string" && (value.includes("NULL") || value.includes("/dev/null"))));
}
/**
 * 只捕获属于下一次 fork 的同步、精确 Utility 调用。
 * 回调可能同步执行，因此必须在调用 run() 前建立捕获。
 * 这只是有限的日志诊断，不是授权资源退出的关卡。
 */
export function createPm2ForkLogCapture(options) {
    let streams;
    let unavailable = "logging-container-not-captured";
    let used = false;
    let inCapturedCallback = false;
    const utility = options.utility;
    const descriptor = utility && !types.isProxy(utility)
        ? Object.getOwnPropertyDescriptor(utility, "startLogging")
        : undefined;
    const original = descriptor &&
        "value" in descriptor &&
        descriptor.writable &&
        typeof descriptor.value === "function"
        ? descriptor.value
        : undefined;
    const report = (child, result) => {
        try {
            options.report?.({ event: `pm2-log-${result.status}`, pid: child.pid, reason: result.reason });
        }
        catch {
            // 诊断不能改变 PM2 原生命周期或错误处理。
        }
    };
    const restore = (capture) => {
        const current = utility && Object.getOwnPropertyDescriptor(utility, "startLogging");
        if (utility && descriptor && current && "value" in current && current.value === capture)
            Object.defineProperty(utility, "startLogging", descriptor);
    };
    return {
        /** 在门控下执行一次日志工具调用。 */
        run(invoke) {
            if (used || !utility || !descriptor || !original || types.isProxy(utility))
                return invoke();
            used = true;
            /** 捕获日志流参数。 */
            function capture(candidate, ...args) {
                // 委托前先恢复原方法；全部输出路径禁用文件日志时，
                // startLogging 可能同步回调，并重入另一个 fork。
                restore(capture);
                try {
                    if (samePaths(candidate, options.expectedPaths))
                        streams = candidate;
                    else
                        unavailable = "logging-container-mismatch";
                }
                catch {
                    unavailable = "logging-container-unsupported";
                }
                if (typeof args[0] !== "function") {
                    unavailable = "logging-callback-unsupported";
                    streams = undefined;
                    return Reflect.apply(original, this, [candidate, ...args]);
                }
                const callback = args[0];
                return Reflect.apply(original, this, [
                    candidate,
                    function (...values) {
                        inCapturedCallback = true;
                        try {
                            return Reflect.apply(callback, this, values);
                        }
                        finally {
                            inCapturedCallback = false;
                        }
                    },
                    ...args.slice(1),
                ]);
            }
            Object.defineProperty(utility, "startLogging", { ...descriptor, value: capture });
            try {
                return invoke();
            }
            finally {
                restore(capture);
            }
        },
        /** 为子进程创建日志门控。 */
        bind(child) {
            const existing = gates.get(child);
            if (existing)
                return existing;
            const unsupported = (reason) => {
                const result = { status: "not-drained", reason };
                const gate = { settled: Promise.resolve(result), result };
                gates.set(child, gate);
                report(child, result);
                return gate;
            };
            if (!streams)
                return unsupported(unavailable);
            if (!inCapturedCallback)
                return unsupported("logging-callback-owner-unconfirmed");
            let raw;
            let close;
            let reloadDescriptor;
            let writers;
            const inputs = [child.stdout, child.stderr];
            try {
                const listeners = EventEmitter.prototype.rawListeners.call(child, "exit");
                const known = listeners.filter(listener => {
                    const actual = ownData(listener, "listener");
                    return (typeof actual === "function" &&
                        createHash("sha256")
                            .update(Reflect.apply(toString, actual, []).replace(/\r\n/g, "\n"))
                            .digest("hex") === forkCloseHash);
                });
                if (known.length !== 1 || listeners[0] !== known[0])
                    return unsupported("fork-close-listener-unsupported");
                raw = known[0];
                close = ownData(raw, "listener");
                const reload = Object.getOwnPropertyDescriptor(child, "_reloadLogs");
                if (!reload ||
                    !("value" in reload) ||
                    !reload.writable ||
                    typeof reload.value !== "function")
                    return unsupported("reload-logs-method-unsupported");
                reloadDescriptor = reload;
                if (inputs.some(input => !(input instanceof Readable) || types.isProxy(input)))
                    return unsupported("child-output-pipe-unsupported");
                writers = [];
                for (const key of Reflect.ownKeys(streams)) {
                    const value = ownData(streams, key);
                    if (nativeWriter(value))
                        writers.push(value);
                    else if (!disabledLog(value))
                        return unsupported("logging-stream-unsupported");
                }
                writers = [...new Set(writers)];
            }
            catch {
                return unsupported("logging-shape-unsupported");
            }
            const container = streams;
            const snapshot = Reflect.ownKeys(container).map(key => [key, ownData(container, key)]);
            let resolve;
            const gate = {
                settled: new Promise(done => {
                    resolve = done;
                }),
            };
            gates.set(child, gate);
            let failure;
            let exited = false;
            let finished = false;
            let exitThis;
            let exitArgs = [];
            let deadline;
            const observers = [];
            const waiters = new Set();
            const finish = (reason) => {
                if (finished)
                    return;
                finished = true;
                if (deadline)
                    clearTimeout(deadline);
                for (const cleanup of observers)
                    cleanup();
                for (const cancel of [...waiters])
                    cancel();
                let closeError;
                let threw = false;
                try {
                    Reflect.apply(close, exitThis, exitArgs);
                }
                catch (error) {
                    closeError = error;
                    threw = true;
                }
                const failureReason = threw ? "logging-fork-close-threw" : reason;
                const result = failureReason
                    ? {
                        status: "not-drained",
                        reason: failureReason,
                        ...(threw ? { fatal: true } : {}),
                    }
                    : { status: "drained" };
                gate.result = result;
                report(child, result);
                resolve(result);
                if (threw)
                    throw closeError;
            };
            const taint = (reason) => {
                failure ??= reason;
                if (exited)
                    finish(failure);
            };
            for (const emitter of [...inputs, ...writers]) {
                const onError = () => taint("logging-stream-error");
                emitter.on(errorMonitor, onError);
                observers.push(() => emitter.removeListener(errorMonitor, onError));
            }
            const reload = reloadDescriptor.value;
            /** 记录日志重载调用并标记失败。 */
            function reloadLogs(...args) {
                failure ??= "reload-logs-called";
                try {
                    return Reflect.apply(reload, this, args);
                }
                finally {
                    if (exited)
                        finish(failure);
                }
            }
            Object.defineProperty(child, "_reloadLogs", { ...reloadDescriptor, value: reloadLogs });
            /** 等待事件或条件就绪。 */
            function wait(emitter, event, ready) {
                if (finished || ready())
                    return Promise.resolve();
                return new Promise(done => {
                    const cancel = () => {
                        emitter.removeListener(event, complete);
                        waiters.delete(cancel);
                        done();
                    };
                    const complete = () => cancel();
                    waiters.add(cancel);
                    emitter.once(event, complete);
                    if (finished || ready())
                        cancel();
                });
            }
            /** 等待全部输入流排空。 */
            async function drain() {
                for (const input of inputs) {
                    await wait(input, "end", () => input.readableEnded);
                    if (finished)
                        return;
                    await wait(input, "close", () => input.closed);
                    if (finished)
                        return;
                }
                if (Reflect.ownKeys(container).length !== snapshot.length ||
                    snapshot.some(([key, value]) => ownData(container, key) !== value)) {
                    finish("logging-container-changed");
                    return;
                }
                for (const writer of writers) {
                    if (finished)
                        return;
                    if (writer.destroyed && !writer.writableFinished) {
                        finish("logging-stream-closed-before-finish");
                        return;
                    }
                    const done = wait(writer, "finish", () => writer.writableFinished);
                    Reflect.apply(Writable.prototype.end, writer, []);
                    await done;
                    if (finished)
                        return;
                    await wait(writer, "close", () => writer.closed);
                    if (finished)
                        return;
                }
                finish();
            }
            /** 子进程退出时结束门控。 */
            function onExit(...args) {
                if (exited)
                    return;
                exited = true;
                exitThis = this;
                exitArgs = args;
                if (failure)
                    return finish(failure);
                deadline = setTimeout(() => finish("logging-drain-timeout"), Math.max(1, options.timeout));
                deadline.unref();
                void drain().catch(error => {
                    // PM2 原始关闭方法或日志方法抛出的异常必须保持可见，
                    // 即使该调用被我们的异步排空延后。
                    if (finished) {
                        process.nextTick(() => {
                            throw error;
                        });
                        return;
                    }
                    try {
                        finish("logging-drain-failed");
                    }
                    catch (closeError) {
                        process.nextTick(() => {
                            throw closeError;
                        });
                    }
                });
            }
            EventEmitter.prototype.removeListener.call(child, "exit", raw);
            EventEmitter.prototype.prependOnceListener.call(child, "exit", onExit);
            return gate;
        },
    };
}
//# sourceMappingURL=log-stream-gate-v1.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("pm2/log-stream-gate-v1.ts", { pm2LogGateFor, pm2LogDrainTimeout, createPm2ForkLogCapture })
