import path from "node:path";
import { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Pm2BootstrapExit } from "./bootstrap-exit.js";
import { installPm2Compatibility, preflightPm2Compatibility, recognizePm2Child, bindPm2BootstrapExit, assertPm2BootstrapExitSupport, capturePm2Compatibility, } from "./compat-resource-v1.js";
import { canonical, plain, integer, sameNonce, currentDaemonGod, runtimeContext, } from "./god-context.js";
import { closeRegistryFor } from "./inspector-session-v1.js";
import { ownData, ownRegistry, writableOwn, replaceOwnedValues, captureOwnRecords, nativeCollection, } from "./legacy-sidecar.js";
import { createPm2ForkLogCapture, pm2LogDrainTimeout } from "./log-stream-gate-v1.js";
import { ticketKey, validateOptions, nestedEnvironment, createPatch, commitPatch, matchesApplication, } from "./application.js";
import { M } from "../shared/messages.js";
export { resolveCachedGod } from "./god-context.js";
export { preparePm2InspectorClose, preparePm2InspectorCloseWithGod, } from "./inspector-session-v1.js";
export const pm2AgentCapabilities = Object.freeze({
    agentProtocol: 2,
    bootstrapExitBarrier: 1,
    cachedRegistryUpgrade: 1,
});
const legacyRegistryKey = Symbol.for("yunzai-guard.pm2-daemon.v1");
const registryKey = Symbol.for("yunzai-guard.pm2-daemon.resource.v1");
/** 读取并校验 daemon 上的登记表。 */
function readRegistry(god, key) {
    const value = ownRegistry(god, key);
    if (!value)
        return undefined;
    if (!value ||
        !plain(value) ||
        value.protocol !== 1 ||
        !nativeCollection(value.applications, Map.prototype) ||
        [...value.applications].some(([id, app]) => !integer(id, 0, 2147483647) ||
            !plain(app) ||
            Reflect.ownKeys(app).some(key => {
                ownData(app, key);
                return false;
            }) ||
            ownData(app, "pmId") !== id ||
            typeof ownData(app, "uniqueId") !== "string" ||
            typeof ownData(app, "root") !== "string" ||
            typeof ownData(app, "appPath") !== "string" ||
            typeof ownData(app, "launcherPath") !== "string" ||
            typeof ownData(app, "shutdownTimeout") !== "number" ||
            typeof ownData(app, "startupTimeout") !== "number") ||
        value.forkMode !== ownData(god, "forkMode"))
        throw new Error(M.pm2.daemonRegistry);
    return value;
}
/** 返回当前版本的登记表。 */
function registryFor(god) {
    const registry = readRegistry(god, registryKey);
    const legacy = readRegistry(god, legacyRegistryKey);
    if (registry &&
        ((registry.legacy ?? registry) !== legacy || typeof registry.originalForkMode !== "function"))
        throw new Error(M.pm2.daemonLineage);
    return registry;
}
/** 返回兼容旧版本的登记表。 */
function legacyRegistryFor(god) {
    const registry = registryFor(god);
    return registry ? registry.legacy : readRegistry(god, legacyRegistryKey);
}
/** 纯守护进程状态入口；公开入口还会验证实际 Node 角色。 */
export async function registerPm2ApplicationWithGod(god, options, context) {
    validateOptions(options, context);
    const root = canonical(options.root);
    const launcherPath = canonical(options.launcherPath);
    const appPath = canonical(path.join(root, "app.js"));
    if (!launcherPath.startsWith(root + path.sep) ||
        path.basename(launcherPath) !== "launcher.js" ||
        path.basename(path.dirname(launcherPath)) !== "dist")
        throw new Error(M.pm2.launcherOutside);
    preflightPm2Compatibility(god, launcherPath);
    if (options.requestRestart)
        assertPm2BootstrapExitSupport(god);
    if (typeof ownData(god, "forkMode") !== "function" ||
        typeof ownData(god, "restartProcessId") !== "function")
        throw new Error(M.pm2.daemonMethods);
    const registry = registryFor(god);
    const legacy = legacyRegistryFor(god);
    const revalidateRegistries = captureOwnRecords([registry, legacy]);
    const revalidateCompatibility = capturePm2Compatibility(god);
    writableOwn(god, ["forkMode"]);
    const revalidateMethods = captureOwnRecords([god], ["processIsDead", "handleExit", "forkMode", "restartProcessId"]);
    const methods = {
        processIsDead: god.processIsDead,
        handleExit: god.handleExit,
        forkMode: god.forkMode,
        restartProcessId: god.restartProcessId,
    };
    if (!registry) {
        writableOwn(god, ["forkMode"]);
        if (legacy)
            writableOwn(legacy, ["forkMode"]);
        if (!Object.isExtensible(god))
            throw new Error(M.pm2.godFrozen);
    }
    const child = god.clusters_db[String(options.pmId)];
    const environment = child?.pm2_env;
    if (!(child instanceof ChildProcess) ||
        child.pid !== options.pid ||
        child.exitCode !== null ||
        child.signalCode !== null ||
        !environment ||
        !plain(environment) ||
        environment.pm_id !== options.pmId ||
        environment.exec_mode !== "fork_mode" ||
        typeof environment.status !== "string" ||
        !["online", "launching"].includes(environment.status) ||
        typeof environment.unique_id !== "string" ||
        !environment.unique_id ||
        typeof environment.pm_cwd !== "string" ||
        canonical(environment.pm_cwd) !== root ||
        typeof environment.pm_exec_path !== "string")
        throw new Error(M.pm2.appMismatch);
    const script = canonical(environment.pm_exec_path);
    if (script !== appPath && script !== launcherPath)
        throw new Error(M.pm2.entryNotAllowed);
    const ownInspectorClose = options.ownInspectorUrl === undefined ? undefined : closeRegistryFor(god)?.requests.get(child);
    if (options.ownInspectorUrl !== undefined &&
        (!ownInspectorClose ||
            ownInspectorClose.url !== options.ownInspectorUrl ||
            !sameNonce(ownInspectorClose.nonce, options.nonce)))
        throw new Error(M.pm2.cleanupUnprepared);
    for (const other of Object.values(god.clusters_db)) {
        if (other === child ||
            !(other instanceof ChildProcess) ||
            !other.pid ||
            other.exitCode !== null ||
            other.signalCode !== null)
            continue;
        const otherEnvironment = other.pm2_env;
        if (typeof otherEnvironment?.pm_cwd !== "string")
            continue;
        let otherRoot;
        try {
            otherRoot = canonical(otherEnvironment.pm_cwd);
        }
        catch {
            continue;
        }
        if (otherRoot !== root || typeof otherEnvironment.pm_exec_path !== "string")
            continue;
        let otherScript;
        try {
            otherScript = canonical(otherEnvironment.pm_exec_path);
        }
        catch {
            continue;
        }
        if (otherScript === appPath || otherScript === launcherPath)
            throw new Error(M.pm2.projectActive);
    }
    for (const registeredRegistry of [registry, legacy])
        if (registeredRegistry)
            for (const registered of registeredRegistry.applications.values()) {
                if (registered.pmId === options.pmId || registered.root !== root)
                    continue;
                const other = god.clusters_db[String(registered.pmId)];
                if (other instanceof ChildProcess &&
                    other.exitCode === null &&
                    other.signalCode === null &&
                    other.pm2_env.unique_id === registered.uniqueId)
                    throw new Error(M.pm2.projectRegistered);
            }
    const previousLegacy = legacy?.applications.get(options.pmId);
    if (previousLegacy) {
        // 旧适配器将待执行退出回调保存在 WeakMap 中。缺少交接字段，
        // 不能证明冷启动目标空闲，必须保留旧持有者并拒绝操作。
        if (options.requestRestart ||
            previousLegacy.handoff ||
            previousLegacy.cold ||
            previousLegacy.uniqueId !== environment.unique_id ||
            previousLegacy.root !== root ||
            previousLegacy.launcherPath !== launcherPath ||
            script !== launcherPath)
            throw new Error(M.pm2.legacyOwner);
        const nested = nestedEnvironment(environment);
        if (nested)
            delete nested.pm_id;
        return {
            status: "registered",
            daemonPid: context.daemonPid,
            pmId: options.pmId,
            pid: options.pid,
            launcherPath,
            requiresHandoff: false,
        };
    }
    const previous = registry?.applications.get(options.pmId);
    if (previous && previous.uniqueId === environment.unique_id && previous.root !== root)
        throw new Error(M.pm2.registrationConflict);
    if (previous?.handoff?.child === child && previous.handoff.nonce !== options.nonce)
        throw new Error(M.pm2.nonceConflict);
    if (previous?.cold) {
        if (previous.cold.child === child &&
            previous.cold.environment === environment &&
            options.requestRestart &&
            previous.cold.nonce === options.nonce &&
            previous.cold.redisPid === options.bootstrapRedisPid) {
            if (previous.cold.gate.failed)
                throw new Error(M.pm2.coldExitFailed);
            return {
                status: "registered",
                daemonPid: context.daemonPid,
                pmId: options.pmId,
                pid: options.pid,
                launcherPath,
                requiresHandoff: true,
                bootstrapExitBarrier: 1,
            };
        }
        if (!previous.cold.gate.released || previous.cold.child === child)
            throw new Error(M.pm2.coldExitUnconfirmed);
    }
    if (options.requestRestart && script !== appPath)
        throw new Error(M.pm2.coldEntry);
    const app = {
        pmId: options.pmId,
        uniqueId: environment.unique_id,
        root,
        appPath,
        launcherPath,
        shutdownTimeout: options.shutdownTimeout,
        startupTimeout: options.startupTimeout,
        handoff: previous?.handoff?.child === child ? previous.handoff : undefined,
    };
    let patch = createPatch(environment, app);
    let committedLineage;
    const validColdGeneration = () => {
        try {
            if (!committedLineage)
                return false;
            committedLineage();
            return (god.clusters_db[String(app.pmId)] === child &&
                child.pm2_env === environment &&
                matchesApplication(child.pm2_env, app));
        }
        catch {
            return false;
        }
    };
    if (app.handoff)
        return {
            status: "registered",
            daemonPid: context.daemonPid,
            pmId: options.pmId,
            pid: options.pid,
            launcherPath,
            requiresHandoff: true,
        };
    if (options.requestRestart) {
        const timeout = options.startupTimeout + options.shutdownTimeout + 10000;
        const started = performance.now();
        const watch = context.watchBootstrapExit ??
            (await import("../host/bootstrap/exit-watch.js")).watchBootstrapExit;
        const observer = await watch(options.pid, options.bootstrapRedisPid, timeout);
        try {
            revalidateRegistries();
            revalidateCompatibility();
            revalidateMethods();
            // await 之后必须复核，不能据旧状态授权替代代次或过期元数据。
            if (god.clusters_db[String(options.pmId)] !== child ||
                child.pm2_env !== environment ||
                child.exitCode !== null ||
                child.signalCode !== null ||
                registryFor(god) !== registry ||
                legacyRegistryFor(god) !== legacy ||
                legacy?.applications.get(options.pmId) !== previousLegacy ||
                god.processIsDead !== methods.processIsDead ||
                god.handleExit !== methods.handleExit ||
                god.restartProcessId !== methods.restartProcessId ||
                god.forkMode !== methods.forkMode ||
                registry?.applications.get(options.pmId) !== previous ||
                environment.unique_id !== app.uniqueId ||
                environment.pm_id !== app.pmId ||
                environment.exec_mode !== "fork_mode" ||
                canonical(environment.pm_cwd) !== root ||
                canonical(environment.pm_exec_path) !== appPath)
                throw new Error(M.pm2.appChanged);
            preflightPm2Compatibility(god, launcherPath);
            if (!registry) {
                writableOwn(god, ["forkMode"]);
                if (legacy)
                    writableOwn(legacy, ["forkMode"]);
            }
            const identities = observer.identities;
            if (identities.length !== (options.bootstrapRedisPid === null ? 1 : 2) ||
                identities[0]?.pid !== options.pid ||
                (options.bootstrapRedisPid !== null &&
                    (identities[1]?.pid !== options.bootstrapRedisPid ||
                        identities[1]?.parentPid !== options.pid)))
                throw new Error(M.pm2.observerBind);
            const remaining = timeout - (performance.now() - started);
            if (remaining <= 0)
                throw new Error(M.pm2.observerTimeout);
            patch = createPatch(environment, app);
            app.cold = {
                child,
                environment,
                nonce: options.nonce,
                redisPid: options.bootstrapRedisPid,
                gate: new Pm2BootstrapExit(child, options.nonce, observer, remaining, validColdGeneration, reason => {
                    try {
                        context.report?.({
                            event: "pm2-bootstrap-exit-failed",
                            pmId: app.pmId,
                            pid: options.pid,
                            reason,
                        });
                    }
                    catch { }
                }),
            };
        }
        catch (error) {
            await observer.close();
            throw error;
        }
    }
    const emit = event => {
        try {
            context.report?.(event);
        }
        catch {
            // 诊断输出不能授权生命周期操作。
        }
    };
    try {
        // 以上验证全部完成后，才能安装钩子或修改应用元数据。
        installPm2Compatibility(god, { launcherPath, report: emit });
        let activeRegistry = registry;
        if (!activeRegistry) {
            const applications = new Map();
            const originalForkMode = god.forkMode;
            const forkMode = function (nextEnvironment, callback) {
                const application = applications.get(Number(nextEnvironment.pm_id));
                // 新的 PM2 id 不能绕过仍持有的原应用或启动器资源记录。
                // 其他脚本可以合法共用 cwd，其原处理路径保持不变。
                let coldProject = false;
                for (const held of applications.values()) {
                    if (!held.cold ||
                        held.cold.gate.released ||
                        typeof nextEnvironment.pm_exec_path !== "string")
                        continue;
                    const entry = path.normalize(nextEnvironment.pm_exec_path);
                    const normalized = process.platform === "win32" ? entry.toLowerCase() : entry;
                    coldProject = [held.appPath, held.launcherPath].includes(normalized);
                    try {
                        coldProject ||= [held.appPath, held.launcherPath].includes(canonical(nextEnvironment.pm_exec_path));
                    }
                    catch { }
                    if (coldProject)
                        break;
                }
                if (coldProject) {
                    callback.call(this, new Error(M.pm2.resourceExit));
                    return false;
                }
                if (!application || !matchesApplication(nextEnvironment, application))
                    return Reflect.apply(originalForkMode, this, [nextEnvironment, callback]);
                const legacyOwner = legacy?.applications.get(application.pmId);
                if (legacyOwner && legacyOwner.uniqueId === application.uniqueId) {
                    callback.call(this, new Error(M.pm2.ticketOwner));
                    return false;
                }
                const nextPatch = createPatch(nextEnvironment, application);
                const ticket = randomBytes(32).toString("hex");
                commitPatch(nextEnvironment, nextPatch);
                nextEnvironment[ticketKey] = ticket;
                nextEnvironment.env[ticketKey] = ticket;
                const expectedPaths = {
                    out: nextEnvironment.pm_out_log_path,
                    err: nextEnvironment.pm_err_log_path,
                    ...("pm_log_path" in nextEnvironment ? { std: nextEnvironment.pm_log_path } : {}),
                };
                const logging = createPm2ForkLogCapture({
                    utility: context.loggingUtility,
                    expectedPaths,
                    timeout: pm2LogDrainTimeout(nextEnvironment.kill_timeout),
                    report: emit,
                });
                return logging.run(() => Reflect.apply(originalForkMode, this, [
                    nextEnvironment,
                    function (error, spawned) {
                        // 系统子进程已继承环境快照；能力凭据仅保存在此闭包中，
                        // 不进入 jlist 或后续 PM2 元数据。
                        delete nextEnvironment[ticketKey];
                        delete nextEnvironment.env[ticketKey];
                        if (!error &&
                            spawned instanceof ChildProcess &&
                            spawned.pm2_env === nextEnvironment &&
                            integer(spawned.pid, 2, 2147483647)) {
                            logging.bind(spawned);
                            recognizePm2Child(god, spawned);
                            const listener = (message) => {
                                if (!plain(message) ||
                                    message.type !== "yunzai-guard-pm2-check" ||
                                    !sameNonce(message.nonce, ticket) ||
                                    god.clusters_db[String(application.pmId)] !== spawned ||
                                    !matchesApplication(spawned.pm2_env, application) ||
                                    spawned.pid === undefined ||
                                    !spawned.connected)
                                    return;
                                spawned.removeListener("message", listener);
                                try {
                                    spawned.send({
                                        type: "yunzai-guard-pm2-registered",
                                        nonce: ticket,
                                        pid: spawned.pid,
                                        pmId: application.pmId,
                                        daemonPid: context.daemonPid,
                                        launcherPath: application.launcherPath,
                                    }, () => { });
                                }
                                catch {
                                    // 子进程同时退出不代表身份验证成功。
                                }
                            };
                            spawned.on("message", listener);
                            spawned.once("exit", () => spawned.removeListener("message", listener));
                        }
                        return Reflect.apply(callback, this, [error, spawned]);
                    },
                ]));
            };
            replaceOwnedValues([
                { object: god, key: "forkMode", previous: originalForkMode, next: forkMode },
                ...(legacy
                    ? [{ object: legacy, key: "forkMode", previous: originalForkMode, next: forkMode }]
                    : []),
            ]);
            activeRegistry = {
                protocol: 1,
                applications,
                forkMode,
                originalForkMode,
                ...(legacy ? { legacy } : {}),
            };
            Object.defineProperty(god, registryKey, { value: activeRegistry });
            if (!legacy)
                Object.defineProperty(god, legacyRegistryKey, { value: activeRegistry });
        }
        previous?.handoff && previous.handoff !== app.handoff && previous.handoff.dispose();
        commitPatch(environment, patch);
        recognizePm2Child(god, child);
        if (app.cold) {
            try {
                bindPm2BootstrapExit(god, child, app.cold.gate);
            }
            catch (error) {
                app.cold.gate.fail("bootstrap-adapter-unavailable");
                throw error;
            }
        }
        activeRegistry.applications.set(options.pmId, app);
        const installedMethods = captureOwnRecords([god], ["processIsDead", "handleExit", "forkMode", "restartProcessId"]);
        const installedRegistries = captureOwnRecords([activeRegistry, activeRegistry.legacy]);
        const installedCompatibility = capturePm2Compatibility(god);
        committedLineage = () => {
            installedMethods();
            installedRegistries();
            installedCompatibility();
            if (registryFor(god) !== activeRegistry || activeRegistry.applications.get(app.pmId) !== app)
                throw new Error(M.pm2.registryOwner);
            if (activeRegistry.legacy?.applications.has(app.pmId))
                throw new Error(M.pm2.ticketOwner);
        };
        const requiresHandoff = Boolean(app.handoff) || (options.requestRestart && script === appPath);
        if (requiresHandoff && !app.handoff) {
            const dispose = () => {
                clearTimeout(timer);
                child.removeListener("message", listener);
                child.removeListener("exit", dispose);
                if (app.handoff?.child === child)
                    app.handoff = undefined;
            };
            const listener = (message) => {
                if (!plain(message) ||
                    message.type !== "yunzai-guard-pm2-handoff" ||
                    !sameNonce(message.nonce, options.nonce))
                    return;
                if (ownInspectorClose && !ownInspectorClose.closed)
                    return;
                try {
                    if (!committedLineage)
                        throw new Error(M.pm2.lineageUnavailable);
                    committedLineage();
                }
                catch {
                    app.cold?.gate.fail("bootstrap-method-lineage-changed");
                    dispose();
                    emit({
                        event: "pm2-handoff-failed",
                        pmId: options.pmId,
                        pid: options.pid,
                        reason: "method-lineage-changed",
                    });
                    return;
                }
                if (god.clusters_db[String(options.pmId)] !== child ||
                    child.pm2_env !== environment ||
                    !matchesApplication(child.pm2_env, app)) {
                    app.cold?.gate.fail("bootstrap-generation-changed");
                    dispose();
                    return;
                }
                dispose();
                emit({ event: "pm2-handoff-requested", pmId: options.pmId, pid: options.pid });
                god.restartProcessId({ id: options.pmId }, error => {
                    if (error) {
                        app.cold?.gate.fail("bootstrap-restart-request-failed");
                        emit({ event: "pm2-handoff-failed", pmId: options.pmId, pid: options.pid });
                    }
                });
            };
            const timer = setTimeout(() => {
                dispose();
                emit({ event: "pm2-handoff-timeout", pmId: options.pmId, pid: options.pid });
            }, Math.max(1000, Math.min(60000, options.startupTimeout + 10000)));
            timer.unref();
            app.handoff = { child, nonce: options.nonce, dispose };
            child.on("message", listener);
            child.once("exit", dispose);
        }
        emit({ event: "pm2-application-registered", pmId: options.pmId, pid: options.pid });
        return {
            status: "registered",
            daemonPid: context.daemonPid,
            pmId: options.pmId,
            pid: options.pid,
            launcherPath,
            requiresHandoff,
            ...(app.cold ? { bootstrapExitBarrier: 1 } : {}),
        };
    }
    catch (error) {
        app.cold?.gate.fail("bootstrap-registration-failed");
        throw error;
    }
}
/** 仅在客户端通过 Inspector 识别自己的父守护进程后调用。 */
export async function registerPm2Application(options) {
    validateOptions(options, { daemonPid: process.pid });
    if (canonical(options.launcherPath) !==
        canonical(fileURLToPath(new URL("../launcher.js", import.meta.url))))
        throw new Error(M.pm2.launcherForeign);
    return registerPm2ApplicationWithGod(currentDaemonGod(options), options, runtimeContext(options.pm2Root));
}
//# sourceMappingURL=agent-v2.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("pm2/agent-v2.ts", { pm2AgentCapabilities, registerPm2ApplicationWithGod, registerPm2Application })
