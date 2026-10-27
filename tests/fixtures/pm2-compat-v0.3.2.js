import fs from "node:fs";
import path from "node:path";
import { ChildProcess } from "node:child_process";
const installations = new WeakMap();
function canonical(file) {
    const resolved = path.normalize(fs.realpathSync.native(file));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function normalized(file) {
    const resolved = path.normalize(file);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
/**
 * PM2 6.0.14 checks kernel liveness separately from its ChildProcess exit handler.
 * Only the explicitly selected launcher receives a barrier between those observations.
 * A failed barrier intentionally never completes PM2's stop callback: its restart
 * implementation ignores stop errors, so returning an error could still start a new host.
 */
export function installPm2Compatibility(god, options) {
    if (!path.isAbsolute(options.launcherPath))
        throw new Error("PM2 launcher must be absolute");
    const launcher = canonical(options.launcherPath);
    if (!god ||
        typeof god !== "object" ||
        !god.clusters_db ||
        typeof god.clusters_db !== "object" ||
        Array.isArray(god.clusters_db))
        throw new Error("Unsupported PM2 God shape");
    const installed = installations.get(god);
    if (installed) {
        if (installed !== launcher)
            throw new Error("PM2 compatibility already targets another launcher");
        return;
    }
    if (typeof god.processIsDead !== "function" || typeof god.handleExit !== "function")
        throw new Error("Unsupported PM2 God methods");
    const originalProcessIsDead = god.processIsDead;
    const originalHandleExit = god.handleExit;
    const states = new WeakMap();
    const recognized = new WeakSet();
    const report = (event) => {
        try {
            options.report?.(event);
        }
        catch {
            // A diagnostic destination must not alter PM2's lifecycle.
        }
    };
    const matches = (environment) => {
        if (environment.exec_mode !== "fork_mode" || typeof environment.pm_exec_path !== "string")
            return false;
        if (!path.isAbsolute(environment.pm_exec_path))
            return false;
        // The launcher can be replaced during an update. Its already validated exact
        // canonical path must remain protected while the on-disk entry is unavailable.
        if (normalized(environment.pm_exec_path) === launcher)
            return true;
        try {
            return canonical(environment.pm_exec_path) === launcher;
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
        for (const pending of [...state.pending])
            pending.fail(state.failure);
    };
    god.handleExit = function (child, ...args) {
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
    god.processIsDead = function (pid, environment, callback, sigkill) {
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
        // PM2 can wait twice (graceful stop, then SIGKILL). This is a failure deadline,
        // never a delay that authorizes a successful restart.
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
            if (complete || deferred || !originalCalled || !exited || !state.consumed)
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
    installations.set(god, launcher);
}
//# sourceMappingURL=pm2-compat.js.map