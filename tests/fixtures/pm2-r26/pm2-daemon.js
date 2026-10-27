import fs from "node:fs";
import path from "node:path";
import { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as inspector from "node:inspector";
import { isSupportedPm2Version } from "./pm2-versions.js";
import { installPm2Compatibility, preflightPm2Compatibility, recognizePm2Child, } from "./pm2-compat-v2.js";
const registryKey = Symbol.for("yunzai-guard.pm2-daemon.v1");
const inspectorCloseKey = Symbol.for("yunzai-guard.pm2-inspector-close.v1");
const ticketKey = "YUNZAI_GUARD_PM2_TICKET";
function canonical(file) {
    const value = path.normalize(fs.realpathSync.native(file));
    return process.platform === "win32" ? value.toLowerCase() : value;
}
function plain(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function integer(value, minimum, maximum) {
    return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}
function writable(object, keys) {
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (descriptor) {
            if (!("value" in descriptor) || !descriptor.writable)
                throw new Error("PM2 application has unsupported property descriptors");
        }
        else if (!Object.isExtensible(object))
            throw new Error("PM2 application is not extensible");
    }
}
function validateOptions(options, context) {
    if (!plain(options) ||
        !integer(options.pmId, 0, 2147483647) ||
        !integer(options.pid, 2, 2147483647) ||
        !integer(options.expectedDaemonPid, 2, 2147483647) ||
        options.expectedDaemonPid !== context.daemonPid ||
        !integer(options.shutdownTimeout, 10, 120000) ||
        !integer(options.startupTimeout, 100, 300000) ||
        typeof options.requestRestart !== "boolean" ||
        typeof options.nonce !== "string" ||
        !/^[a-zA-Z0-9_-]{16,128}$/.test(options.nonce))
        throw new Error("Invalid PM2 registration request");
    for (const file of [options.root, options.launcherPath, options.pm2Root])
        if (typeof file !== "string" || !path.isAbsolute(file))
            throw new Error("PM2 registration paths must be absolute");
    if (options.ownInspectorUrl !== undefined)
        validateInspectorUrl(options.ownInspectorUrl);
}
function registryFor(god) {
    if (!Reflect.has(god, registryKey))
        return undefined;
    const value = Reflect.get(god, registryKey);
    if (!value ||
        !plain(value) ||
        value.protocol !== 1 ||
        !(value.applications instanceof Map) ||
        [...value.applications].some(([id, app]) => !integer(id, 0, 2147483647) ||
            !plain(app) ||
            app.pmId !== id ||
            typeof app.uniqueId !== "string" ||
            typeof app.root !== "string" ||
            typeof app.appPath !== "string" ||
            typeof app.launcherPath !== "string" ||
            typeof app.shutdownTimeout !== "number" ||
            typeof app.startupTimeout !== "number") ||
        value.forkMode !== god.forkMode)
        throw new Error("Unsupported PM2 daemon registry");
    return value;
}
function patchFor(environment, app) {
    if (!plain(environment) || (environment.env !== undefined && !plain(environment.env)))
        throw new Error("Unsupported PM2 application environment");
    const codes = environment.stop_exit_codes ?? [];
    const list = Array.isArray(codes) ? [...codes] : [codes];
    if (list.some(code => !/^-?\d+$/.test(String(code)) || !Number.isSafeInteger(Number(code))))
        throw new Error("Unsupported PM2 stop exit codes");
    if (!list.some(code => Number(code) === 78))
        list.push(78);
    const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
    const patch = {
        pm_id: app.pmId,
        unique_id: app.uniqueId,
        pm_cwd: app.root,
        pm_exec_path: app.launcherPath,
        exec_mode: "fork_mode",
        wait_ready: true,
        shutdown_with_message: true,
        kill_timeout: Math.max(finite(environment.kill_timeout), app.shutdownTimeout + 10000),
        listen_timeout: Math.max(finite(environment.listen_timeout), app.startupTimeout + 10000),
        stop_exit_codes: list,
    };
    writable(environment, [...Object.keys(patch), "env", ticketKey]);
    if (environment.env)
        writable(environment.env, [...Object.keys(patch), ticketKey]);
    for (const record of [environment, environment.env]) {
        const descriptor = record && Object.getOwnPropertyDescriptor(record, ticketKey);
        if (descriptor && !descriptor.configurable)
            throw new Error("PM2 ticket metadata must be removable");
    }
    return patch;
}
function commitPatch(environment, patch) {
    Object.assign(environment, patch);
    // executeApp flattens env over its own metadata before forking. Pin both layers
    // for this application so stale ecosystem environment cannot restore app.js.
    environment.env ??= {};
    Object.assign(environment.env, patch);
}
function sameApplication(environment, app) {
    if (environment.pm_id !== app.pmId ||
        environment.unique_id !== app.uniqueId ||
        environment.exec_mode !== "fork_mode" ||
        typeof environment.pm_cwd !== "string" ||
        typeof environment.pm_exec_path !== "string")
        return false;
    try {
        if (canonical(environment.pm_cwd) !== app.root)
            return false;
        const script = canonical(environment.pm_exec_path);
        return script === app.appPath || script === app.launcherPath;
    }
    catch {
        return false;
    }
}
function sameNonce(value, nonce) {
    return (typeof value === "string" &&
        Buffer.byteLength(value) === Buffer.byteLength(nonce) &&
        timingSafeEqual(Buffer.from(value), Buffer.from(nonce)));
}
function validateInspectorUrl(value, closeOnly = false) {
    if (typeof value !== "string" || value.length > 512)
        throw new Error("Invalid temporary Inspector endpoint");
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error("Invalid temporary Inspector endpoint");
    }
    if (url.protocol !== "ws:" ||
        !["127.0.0.1", "[::1]", "localhost", ...(closeOnly ? ["0.0.0.0", "[::]"] : [])].includes(url.hostname) ||
        !integer(Number(url.port), 1, 65535) ||
        url.pathname === "/" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash)
        throw new Error("Invalid temporary Inspector endpoint");
}
function closeRegistryFor(god) {
    if (!Reflect.has(god, inspectorCloseKey))
        return undefined;
    const registry = Reflect.get(god, inspectorCloseKey);
    if (!registry ||
        registry.protocol !== 1 ||
        !(registry.requests instanceof Map) ||
        [...registry.requests].some(([child, request]) => !(child instanceof ChildProcess) ||
            !request ||
            typeof request !== "object" ||
            request.child !== child ||
            typeof request.nonce !== "string" ||
            typeof request.url !== "string" ||
            typeof request.closed !== "boolean" ||
            typeof request.dispose !== "function"))
        throw new Error("Unsupported PM2 Inspector cleanup registry");
    return registry;
}
/** Prepare cleanup independently so even a later registration failure can close its own endpoint. */
export function preparePm2InspectorCloseWithGod(god, options, context) {
    const url = options.ownInspectorUrl ?? options.url;
    validateInspectorUrl(url, true);
    if (!integer(options.pmId, 0, 2147483647) ||
        !integer(options.pid, 2, 2147483647) ||
        options.expectedDaemonPid !== context.daemonPid ||
        typeof options.nonce !== "string" ||
        !/^[a-zA-Z0-9_-]{16,128}$/.test(options.nonce) ||
        (options.url !== undefined &&
            options.ownInspectorUrl !== undefined &&
            options.url !== options.ownInspectorUrl) ||
        !context.inspector ||
        typeof context.inspector.url !== "function" ||
        typeof context.inspector.close !== "function" ||
        context.inspector.url() !== url)
        throw new Error("PM2 temporary Inspector cleanup identity mismatch");
    const child = god.clusters_db[String(options.pmId)];
    if (!(child instanceof ChildProcess) ||
        child.pid !== options.pid ||
        child.exitCode !== null ||
        child.signalCode !== null ||
        !child.connected)
        throw new Error("PM2 Inspector cleanup child identity mismatch");
    let registry = closeRegistryFor(god);
    const existing = registry?.requests.get(child);
    if (existing && (existing.nonce !== options.nonce || existing.url !== url))
        throw new Error("PM2 Inspector cleanup already has another request");
    if (!registry) {
        if (!Object.isExtensible(god))
            throw new Error("PM2 God is not extensible");
        registry = { protocol: 1, requests: new Map() };
        Object.defineProperty(god, inspectorCloseKey, { value: registry });
    }
    if (!existing) {
        const requests = registry.requests;
        let settled = false;
        const dispose = () => {
            clearTimeout(timer);
            child.removeListener("message", listener);
            child.removeListener("exit", dispose);
            if (requests.get(child) === request)
                requests.delete(child);
        };
        const request = {
            child,
            nonce: options.nonce,
            url,
            closed: false,
            dispose,
        };
        const listener = (message) => {
            if (settled ||
                !plain(message) ||
                message.type !== "yunzai-guard-pm2-inspector-close" ||
                !sameNonce(message.nonce, options.nonce) ||
                message.url !== url)
                return;
            if (god.clusters_db[String(options.pmId)] !== child ||
                child.pid !== options.pid ||
                !child.connected ||
                context.inspector.url() !== url)
                return;
            settled = true;
            dispose();
            try {
                // This runs on normal child IPC only after the client closed its WebSocket.
                context.inspector.close();
                if (context.inspector.url() !== undefined)
                    throw new Error("Inspector remained active");
                request.closed = true;
                child.send({
                    type: "yunzai-guard-pm2-inspector-closed",
                    nonce: options.nonce,
                    url,
                    daemonPid: context.daemonPid,
                    pmId: options.pmId,
                    pid: options.pid,
                }, () => { });
            }
            catch {
                try {
                    context.report?.({
                        event: "pm2-inspector-cleanup-failed",
                        pmId: options.pmId,
                        pid: options.pid,
                    });
                }
                catch { }
            }
        };
        const timer = setTimeout(dispose, 60000);
        timer.unref();
        requests.set(child, request);
        child.on("message", listener);
        child.once("exit", dispose);
    }
    return {
        status: "prepared",
        daemonPid: context.daemonPid,
        pmId: options.pmId,
        pid: options.pid,
        nonce: options.nonce,
        url,
    };
}
/** Find the already running daemon's singleton without executing any God module. */
export function resolveCachedGod(cache, physicalGodPath) {
    const expected = canonical(physicalGodPath);
    const matches = [];
    for (const [filename, entry] of Object.entries(cache)) {
        if (!path.isAbsolute(filename))
            continue;
        try {
            if (canonical(filename) === expected)
                matches.push(entry);
        }
        catch {
            // An unrelated stale cache path is not authority to load new code.
        }
    }
    if (matches.length !== 1 || matches[0]?.loaded !== true)
        throw new Error("PM2 God must have one already loaded canonical module");
    const god = matches[0].exports;
    if (!god ||
        typeof god !== "object" ||
        !god.clusters_db ||
        typeof god.clusters_db !== "object" ||
        Array.isArray(god.clusters_db) ||
        typeof god.processIsDead !== "function" ||
        typeof god.handleExit !== "function" ||
        typeof god.forkMode !== "function" ||
        typeof god.restartProcessId !== "function")
        throw new Error("PM2 cached God has an unsupported shape");
    return god;
}
/** Pure daemon-state entry point. The public entry additionally verifies the actual Node role. */
export function registerPm2ApplicationWithGod(god, options, context) {
    validateOptions(options, context);
    const root = canonical(options.root);
    const launcherPath = canonical(options.launcherPath);
    const appPath = canonical(path.join(root, "app.js"));
    if (!launcherPath.startsWith(root + path.sep) ||
        path.basename(launcherPath) !== "launcher.js" ||
        path.basename(path.dirname(launcherPath)) !== "dist")
        throw new Error("PM2 launcher is outside its registered project");
    preflightPm2Compatibility(god, launcherPath);
    if (typeof god.forkMode !== "function" || typeof god.restartProcessId !== "function")
        throw new Error("Unsupported PM2 daemon methods");
    const registry = registryFor(god);
    if (!registry) {
        writable(god, ["forkMode"]);
        if (!Object.isExtensible(god))
            throw new Error("PM2 God is not extensible");
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
        throw new Error("PM2 application identity does not match the registering process");
    const script = canonical(environment.pm_exec_path);
    if (script !== appPath && script !== launcherPath)
        throw new Error("PM2 application entry is not an allowed Guard entry");
    const ownInspectorClose = options.ownInspectorUrl === undefined ? undefined : closeRegistryFor(god)?.requests.get(child);
    if (options.ownInspectorUrl !== undefined &&
        (!ownInspectorClose ||
            ownInspectorClose.url !== options.ownInspectorUrl ||
            !sameNonce(ownInspectorClose.nonce, options.nonce)))
        throw new Error("PM2 temporary Inspector cleanup was not prepared");
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
            throw new Error("Another active PM2 application uses this project");
    }
    if (registry)
        for (const registered of registry.applications.values()) {
            if (registered.pmId === options.pmId || registered.root !== root)
                continue;
            const other = god.clusters_db[String(registered.pmId)];
            if (other instanceof ChildProcess &&
                other.exitCode === null &&
                other.signalCode === null &&
                other.pm2_env.unique_id === registered.uniqueId)
                throw new Error("Another registered PM2 application uses this project");
        }
    const previous = registry?.applications.get(options.pmId);
    if (previous && previous.uniqueId === environment.unique_id && previous.root !== root)
        throw new Error("PM2 registration conflicts with an existing application");
    if (previous?.handoff?.child === child && previous.handoff.nonce !== options.nonce)
        throw new Error("PM2 handoff already has a different nonce");
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
    const patch = patchFor(environment, app);
    if (app.handoff)
        return {
            status: "registered",
            daemonPid: context.daemonPid,
            pmId: options.pmId,
            pid: options.pid,
            launcherPath,
            requiresHandoff: true,
        };
    const emit = event => {
        try {
            context.report?.(event);
        }
        catch {
            // Diagnostic output cannot authorize a lifecycle operation.
        }
    };
    // Every validation above precedes installing hooks or mutating application metadata.
    installPm2Compatibility(god, { launcherPath, report: emit });
    let activeRegistry = registry;
    if (!activeRegistry) {
        const applications = new Map();
        const originalForkMode = god.forkMode;
        god.forkMode = function (nextEnvironment, callback) {
            const application = applications.get(Number(nextEnvironment.pm_id));
            if (!application || !sameApplication(nextEnvironment, application))
                return Reflect.apply(originalForkMode, this, [nextEnvironment, callback]);
            const nextPatch = patchFor(nextEnvironment, application);
            const ticket = randomBytes(32).toString("hex");
            commitPatch(nextEnvironment, nextPatch);
            nextEnvironment[ticketKey] = ticket;
            nextEnvironment.env[ticketKey] = ticket;
            return Reflect.apply(originalForkMode, this, [
                nextEnvironment,
                function (error, spawned) {
                    // The OS child already inherited its environment snapshot. Keep the
                    // capability in this closure, outside jlist and later PM2 metadata.
                    delete nextEnvironment[ticketKey];
                    delete nextEnvironment.env[ticketKey];
                    if (!error &&
                        spawned instanceof ChildProcess &&
                        spawned.pm2_env === nextEnvironment &&
                        integer(spawned.pid, 2, 2147483647)) {
                        recognizePm2Child(god, spawned);
                        const listener = (message) => {
                            if (!plain(message) ||
                                message.type !== "yunzai-guard-pm2-check" ||
                                !sameNonce(message.nonce, ticket) ||
                                god.clusters_db[String(application.pmId)] !== spawned ||
                                !sameApplication(spawned.pm2_env, application) ||
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
                                // A concurrent child exit is not a successful authentication.
                            }
                        };
                        spawned.on("message", listener);
                        spawned.once("exit", () => spawned.removeListener("message", listener));
                    }
                    return Reflect.apply(callback, this, [error, spawned]);
                },
            ]);
        };
        activeRegistry = { protocol: 1, applications, forkMode: god.forkMode };
        Object.defineProperty(god, registryKey, { value: activeRegistry });
    }
    previous?.handoff && previous.handoff !== app.handoff && previous.handoff.dispose();
    commitPatch(environment, patch);
    recognizePm2Child(god, child);
    activeRegistry.applications.set(options.pmId, app);
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
            if (god.clusters_db[String(options.pmId)] !== child ||
                !sameApplication(child.pm2_env, app)) {
                dispose();
                return;
            }
            dispose();
            emit({ event: "pm2-handoff-requested", pmId: options.pmId, pid: options.pid });
            god.restartProcessId({ id: options.pmId }, error => {
                if (error)
                    emit({ event: "pm2-handoff-failed", pmId: options.pmId, pid: options.pid });
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
    };
}
function currentDaemonGod(options) {
    if (!integer(options.expectedDaemonPid, 2, 2147483647) ||
        options.expectedDaemonPid !== process.pid ||
        typeof options.pm2Root !== "string" ||
        !path.isAbsolute(options.pm2Root))
        throw new Error("PM2 runtime daemon identity mismatch");
    if (!["win32", "linux"].includes(process.platform))
        throw new Error("PM2 runtime registration requires Windows or Linux");
    // Keep loader/file paths in their native physical casing. On Windows a folded
    // require path can execute a second CJS God module with an empty database.
    const pm2Root = fs.realpathSync.native(options.pm2Root);
    const main = fs.realpathSync.native(process.argv[1] ?? "");
    if (canonical(main) !== canonical(path.join(pm2Root, "lib", "Daemon.js")))
        throw new Error("PM2 registration is not executing in the expected daemon");
    const metadata = JSON.parse(fs.readFileSync(path.join(pm2Root, "package.json"), "utf8"));
    if (!plain(metadata) || metadata.name !== "pm2" || !isSupportedPm2Version(metadata.version))
        throw new Error("PM2 runtime registration requires a supported PM2 version");
    const require = createRequire(main);
    return resolveCachedGod(require.cache, fs.realpathSync.native(path.join(pm2Root, "lib", "God.js")));
}
function runtimeContext() {
    return {
        daemonPid: process.pid,
        report: event => console.error("[Yunzai Guard PM2] " + JSON.stringify(event)),
        inspector: { url: inspector.url, close: inspector.close },
    };
}
export function preparePm2InspectorClose(options) {
    return preparePm2InspectorCloseWithGod(currentDaemonGod(options), options, runtimeContext());
}
/** Called only after the client has identified its own parent daemon over Inspector. */
export function registerPm2Application(options) {
    validateOptions(options, { daemonPid: process.pid });
    if (canonical(options.launcherPath) !==
        canonical(fileURLToPath(new URL("./launcher.js", import.meta.url))))
        throw new Error("PM2 launcher does not belong to this Guard module");
    return registerPm2ApplicationWithGod(currentDaemonGod(options), options, runtimeContext());
}
//# sourceMappingURL=pm2-daemon.js.map