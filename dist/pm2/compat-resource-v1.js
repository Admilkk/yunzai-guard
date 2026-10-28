import fs from "node:fs";
import path from "node:path";
import { ChildProcess } from "node:child_process";
import { ownData, ownRegistry, writableOwn, replaceOwnedValues, captureOwnRecords, nativeCollection, } from "./legacy-sidecar.js";
import { pm2LogGateFor } from "./log-stream-gate-v1.js";
import { M } from "../shared/messages.js";
const installationKey = Symbol.for("yunzai-guard.pm2-compat.v1");
const resourceKey = Symbol.for("yunzai-guard.pm2-compat.resource.v1");
/** 读取 daemon 上的兼容层安装记录。 */
function installationFor(god, key = installationKey) {
    const installed = ownRegistry(god, key);
    if (!installed)
        return undefined;
    if (installed.protocol !== 1 ||
        !nativeCollection(installed.launchers, Set.prototype) ||
        [...installed.launchers].some(value => typeof value !== "string") ||
        installed.processIsDead !== ownData(god, "processIsDead") ||
        installed.handleExit !== ownData(god, "handleExit") ||
        typeof installed.recognize !== "function" ||
        (installed.bootstrapExitProtocol !== undefined && installed.bootstrapExitProtocol !== 1) ||
        (installed.bootstrapExitProtocol === 1 && typeof installed.bindBootstrapExit !== "function"))
        throw new Error(M.pm2.compatRegistry);
    return installed;
}
/** 读取 daemon 上的资源安装记录。 */
function resourceFor(god) {
    const resource = installationFor(god, resourceKey);
    if (!resource)
        return undefined;
    const legacy = installationFor(god);
    if ((resource.legacy ?? resource) !== legacy ||
        typeof resource.originalProcessIsDead !== "function" ||
        typeof resource.originalHandleExit !== "function")
        throw new Error(M.pm2.compatLineage);
    return resource;
}
/** 捕获兼容层记录，返回恢复函数。 */
export function capturePm2Compatibility(god) {
    return captureOwnRecords([installationFor(god), resourceFor(god)]);
}
/** 可以包装已知旧方法；实际关卡仅由新安装的辅助状态绑定。 */
export function assertPm2BootstrapExitSupport(god) {
    const installed = installationFor(god);
    resourceFor(god);
    if (installed)
        writableOwn(installed, ["processIsDead", "handleExit"]);
    writableOwn(god, ["processIsDead", "handleExit"]);
    if (!resourceFor(god) && !Object.isExtensible(god))
        throw new Error(M.pm2.godBarrier);
}
/** 把首次接管的退出门控绑定到 PM2 子进程。 */
export function bindPm2BootstrapExit(god, child, gate) {
    const installation = resourceFor(god);
    if (!installation ||
        installation.bootstrapExitProtocol !== 1 ||
        typeof installation.bindBootstrapExit !== "function")
        throw new Error(M.pm2.barrierUnsupported);
    installation.bindBootstrapExit(child, gate);
}
/** PM2 修改元数据前，先绑定刚验证的启动器代次。 */
export function recognizePm2Child(god, child) {
    const installation = resourceFor(god);
    if (!installation || typeof installation.recognize !== "function")
        throw new Error(M.pm2.compatMissing);
    installation.recognize(child);
}
/** 调用方提交相关守护进程状态前必须完成验证。 */
export function preflightPm2Compatibility(god, launcherPath) {
    if (!path.isAbsolute(launcherPath))
        throw new Error(M.pm2.launcherAbsolute);
    canonical(launcherPath);
    if (!god ||
        typeof god !== "object" ||
        !ownData(god, "clusters_db") ||
        typeof ownData(god, "clusters_db") !== "object" ||
        Array.isArray(god.clusters_db) ||
        typeof ownData(god, "processIsDead") !== "function" ||
        typeof ownData(god, "handleExit") !== "function")
        throw new Error(M.pm2.godShape);
    const installed = installationFor(god);
    const resource = resourceFor(god);
    writableOwn(god, ["processIsDead", "handleExit"]);
    if (!resource) {
        if (!Object.isExtensible(god))
            throw new Error(M.pm2.godFrozen);
        writableOwn(god, ["processIsDead", "handleExit"]);
        if (installed)
            writableOwn(installed, ["processIsDead", "handleExit"]);
    }
}
/** 返回规范化的真实路径。 */
function canonical(file) {
    const resolved = path.normalize(fs.realpathSync.native(file));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
/** 返回规范化路径。 */
function normalized(file) {
    const resolved = path.normalize(file);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
/**
 * PM2 6.0.14 的内核存活检查与 ChildProcess 退出处理相互独立。
 * 仅对明确选定的启动器，在这两项观察之间设置关卡。
 * 关卡失败时不完成 PM2 的停止回调；其重启实现忽略停止错误，
 * 返回错误仍可能导致新宿主启动。
 */
export function installPm2Compatibility(god, options) {
    preflightPm2Compatibility(god, options.launcherPath);
    const launcher = canonical(options.launcherPath);
    const installed = resourceFor(god);
    if (installed) {
        installed.launchers.add(launcher);
        return;
    }
    const launchers = new Set([launcher]);
    const legacy = installationFor(god);
    const originalProcessIsDead = god.processIsDead;
    const originalHandleExit = god.handleExit;
    const states = new WeakMap();
    const recognized = new WeakSet();
    const report = (event) => {
        try {
            options.report?.(event);
        }
        catch {
            // 诊断输出目标不能改变 PM2 生命周期。
        }
    };
    const matches = (environment) => {
        if (environment.exec_mode !== "fork_mode" || typeof environment.pm_exec_path !== "string")
            return false;
        if (!path.isAbsolute(environment.pm_exec_path))
            return false;
        // 更新时启动器文件可能被替换；即使磁盘入口暂时不可用，
        // 此前验证的精确规范路径仍须受到保护。
        if (launchers.has(normalized(environment.pm_exec_path)))
            return true;
        try {
            return launchers.has(canonical(environment.pm_exec_path));
        }
        catch {
            return false;
        }
    };
    const target = (child) => {
        if (recognized.has(child))
            return true;
        if (!matches(child.pm2_env))
            return false;
        recognized.add(child);
        return true;
    };
    const stateFor = (child) => {
        let state = states.get(child);
        if (!state) {
            state = { consumed: false, pending: new Set() };
            states.set(child, state);
        }
        return state;
    };
    const failState = (state, reason) => {
        state.failure ??= reason;
        state.bootstrap?.fail(state.failure);
        for (const pending of [...state.pending])
            pending.fail(state.failure);
    };
    const handleExit = function (child, ...args) {
        if (!target(child))
            return Reflect.apply(originalHandleExit, this, [child, ...args]);
        const state = stateFor(child);
        if (god.clusters_db[String(child.pm2_env.pm_id)] !== child) {
            failState(state, "process-generation-changed");
            report({
                event: "pm2-stale-exit-dropped",
                pmId: child.pm2_env.pm_id,
                pid: child.pid,
                reason: "process-generation-changed",
            });
            return false;
        }
        const consume = () => {
            let result;
            try {
                result = Reflect.apply(originalHandleExit, this, [child, ...args]);
            }
            catch (error) {
                failState(state, "handle-exit-threw");
                throw error;
            }
            state.consumed = true;
            for (const pending of state.pending)
                pending.check();
            return result;
        };
        const logging = pm2LogGateFor(child);
        if (logging?.result?.fatal)
            return false;
        if (!state.bootstrap && (!logging || logging.result))
            return consume();
        // 原 handleExit 可能不经 processIsDead 就安排自动 fork。
        if (state.dispatching || state.consumed || state.failure)
            return false;
        state.dispatching = true;
        void Promise.all([state.bootstrap?.exited, logging?.settled]).then(() => {
            if (logging?.result?.fatal)
                return;
            if (state.failure)
                return;
            if (god.clusters_db[String(child.pm2_env.pm_id)] !== child) {
                failState(state, "process-generation-changed");
                return;
            }
            try {
                consume();
            }
            catch { }
        }, () => failState(state, "bootstrap-resource-exit-unconfirmed"));
        return false;
    };
    const processIsDead = function (pid, environment, callback, sigkill) {
        const child = god.clusters_db[String(environment.pm_id)];
        if (!matches(environment) && !(child && recognized.has(child)))
            return Reflect.apply(originalProcessIsDead, this, [pid, environment, callback, sigkill]);
        if (!child ||
            !target(child) ||
            !(child instanceof ChildProcess) ||
            child.pid !== pid ||
            !Number.isSafeInteger(pid) ||
            pid <= 1) {
            report({
                event: "pm2-exit-barrier-failed",
                pmId: environment.pm_id,
                pid,
                reason: "child-process-identity-unavailable",
            });
            return false;
        }
        const state = stateFor(child);
        const logging = pm2LogGateFor(child);
        if (logging?.result)
            state.loggingSettled = true;
        if (logging && !state.loggingSettled) {
            void logging.settled.then(() => {
                state.loggingSettled = true;
                for (const pending of state.pending)
                    pending.check();
            });
        }
        if (state.failure) {
            report({
                event: "pm2-exit-barrier-failed",
                pmId: environment.pm_id,
                pid,
                reason: state.failure,
            });
            return false;
        }
        let exited = typeof child.exitCode === "number" || typeof child.signalCode === "string";
        let originalCalled = false;
        let originalArgs = [];
        let originalThis;
        let complete = false;
        let deferred;
        let callbackToRun = callback;
        const killTimeout = typeof environment.kill_timeout === "number" && Number.isFinite(environment.kill_timeout)
            ? Math.max(0, environment.kill_timeout)
            : 1600;
        // PM2 可能等待两次（优雅停止后再发 SIGKILL）；此期限只用于判定失败，
        // 等待到期绝不代表可以成功重启。
        const deadline = Math.max(1000, Math.min(180000, killTimeout * 3));
        const watchdog = setTimeout(() => failState(state, "exit-barrier-timeout"), deadline);
        watchdog.unref();
        const cleanup = () => {
            clearTimeout(watchdog);
            if (deferred)
                clearImmediate(deferred);
            child.removeListener("exit", onExit);
            state.pending.delete(pending);
        };
        const fail = (reason) => {
            if (complete)
                return;
            complete = true;
            cleanup();
            callbackToRun = undefined;
            originalArgs = [];
            report({ event: "pm2-exit-barrier-failed", pmId: environment.pm_id, pid, reason });
        };
        const check = () => {
            if (complete ||
                deferred ||
                !originalCalled ||
                !exited ||
                !state.consumed ||
                logging?.result?.fatal ||
                (logging && !state.loggingSettled) ||
                (state.bootstrap && !state.bootstrap.released))
                return;
            deferred = setImmediate(() => {
                deferred = undefined;
                if (complete)
                    return;
                if (god.clusters_db[String(environment.pm_id)] !== child) {
                    failState(state, "process-generation-changed");
                    return;
                }
                complete = true;
                cleanup();
                const run = callbackToRun;
                callbackToRun = undefined;
                report({ event: "pm2-exit-barrier-complete", pmId: environment.pm_id, pid });
                if (run)
                    Reflect.apply(run, originalThis, originalArgs);
                originalArgs = [];
            });
        };
        const onExit = () => {
            exited = true;
            check();
        };
        const pending = { check, fail };
        state.pending.add(pending);
        child.once("exit", onExit);
        report({ event: "pm2-exit-barrier-wait", pmId: environment.pm_id, pid });
        try {
            return Reflect.apply(originalProcessIsDead, this, [
                pid,
                environment,
                function (...args) {
                    if (complete || originalCalled)
                        return;
                    originalCalled = true;
                    originalArgs = args;
                    originalThis = this;
                    check();
                },
                sigkill,
            ]);
        }
        catch (error) {
            failState(state, "process-is-dead-threw");
            throw error;
        }
    };
    const installation = {
        protocol: 1,
        launchers,
        processIsDead,
        handleExit,
        originalProcessIsDead,
        originalHandleExit,
        ...(legacy ? { legacy } : {}),
        bootstrapExitProtocol: 1,
        /** 为已识别的子进程绑定退出门控。 */
        bindBootstrapExit(child, gate) {
            if (!recognized.has(child))
                throw new Error(M.pm2.coldUnknown);
            const state = stateFor(child);
            if (state.consumed || state.failure || (state.bootstrap && state.bootstrap !== gate))
                throw new Error(M.pm2.coldBarrier);
            state.bootstrap = gate;
        },
        /** 识别由本兼容层启动的子进程。 */
        recognize(child) {
            if (!(child instanceof ChildProcess) ||
                !Number.isSafeInteger(child.pid) ||
                child.pid <= 1 ||
                (!recognized.has(child) && !matches(child.pm2_env)))
                throw new Error(M.pm2.notLauncher);
            recognized.add(child);
        },
    };
    replaceOwnedValues([
        { object: god, key: "processIsDead", previous: originalProcessIsDead, next: processIsDead },
        { object: god, key: "handleExit", previous: originalHandleExit, next: handleExit },
        ...(legacy
            ? [
                {
                    object: legacy,
                    key: "processIsDead",
                    previous: originalProcessIsDead,
                    next: processIsDead,
                },
                { object: legacy, key: "handleExit", previous: originalHandleExit, next: handleExit },
            ]
            : []),
    ]);
    Object.defineProperty(god, resourceKey, { value: installation });
    if (!legacy)
        Object.defineProperty(god, installationKey, { value: installation });
}
//# sourceMappingURL=compat-resource-v1.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("pm2/compat-resource-v1.ts", { capturePm2Compatibility, assertPm2BootstrapExitSupport, bindPm2BootstrapExit, recognizePm2Child, preflightPm2Compatibility, installPm2Compatibility })
