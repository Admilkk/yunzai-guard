import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import workerThreads from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { getEnvironmentData, isMainThread, MessagePort, setEnvironmentData, threadId, } from "node:worker_threads";
import { parseSettings } from "../config/index.js";
import { installInstrumentation } from "../instrumentation/index.js";
import { IntegrityMonitor } from "../monitor/integrity.js";
import { installSandboxResolution } from "../sandbox/resolution.js";
import { installWorkerMonitor, runtimeKey, workerMetadataKey, } from "./worker-monitor.js";
import { auditProtocol } from "../audit/protocol.js";
import { attach, reportFailure } from "./reporter.js";
import { connectPort } from "./port.js";
import { connectSocket } from "./socket.js";
import { installHookWatch } from "../monitor/watch.js";
import { installFileGuard } from "../protect/files.js";
import { protectObjects, seal, refuse, freezeData } from "../protect/objects.js";
import { installDebugGuard } from "../protect/debug.js";
import { installBindingGuard } from "../protect/bindings.js";
import { installReportGuard } from "../protect/reports.js";
import { installSqliteGuard } from "../protect/sqlite.js";
import { M } from "../shared/messages.js";
let installedRuntime;
const lifecycle = {
    prepare: options => installedRuntime?.prepareAudit(options),
    coverage: () => installedRuntime?.auditCoverage().nestedCoverage ?? "unknown",
    dispose: () => installedRuntime?.instrumentation(),
};
/** 读取并校验运行时清单。 */
function readManifest(filename) {
    const bytes = fs.readFileSync(filename);
    if (bytes.length > 8 * 1024 * 1024)
        throw new Error(M.runtime.manifestTooLarge);
    const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!input ||
        input.version !== 1 ||
        !Number.isSafeInteger(input.generation) ||
        input.generation < 1 ||
        typeof input.projectId !== "string" ||
        typeof input.endpoint !== "string" ||
        !input.endpoint.length ||
        typeof input.token !== "string" ||
        input.token.length < 16)
        throw new Error(M.runtime.manifest);
    return { ...input, settings: parseSettings(input.settings) };
}
/** 共用的同步安装入口，可安全地由 runtime-bootstrap.cjs require。 */
export function installRuntime(options) {
    if (installedRuntime)
        refuse("runtime-reinstall", "guard-runtime");
    freezeData(options.settings);
    const identity = Object.freeze({ ...options.identity });
    const emit = event => options.emit(attach(event, identity));
    const originPlugin = () => options.contextProvider?.() ??
        (identity.originPlugin === "unknown" ? undefined : identity.originPlugin);
    const watch = installHookWatch();
    protectObjects(emit, originPlugin, watch);
    const sealApi = (object, key, value, label) => seal(object, key, value, label ?? String(key), true);
    for (const item of watch.targets())
        sealApi(item.object, item.key, item.value, `hook-watch.${item.key}`);
    installDebugGuard(sealApi, refuse);
    installBindingGuard(sealApi, refuse);
    const roots = [
        fileURLToPath(new URL("../../", import.meta.url)),
        path.join(process.cwd(), "data/yunzai-guard"),
        ...[options.manifestPath, options.resolutionManifestPath].filter((file) => Boolean(file)),
    ];
    installReportGuard({ roots, deny: refuse, seal: sealApi });
    const readRoots = [
        path.join(process.cwd(), "data/yunzai-guard"),
        ...[options.manifestPath, options.resolutionManifestPath].filter((file) => Boolean(file)),
    ];
    // fs 收口先于行为监控安装，业务文件观察在监控就绪后再接入。
    let observeFile;
    installFileGuard({
        roots,
        readRoots,
        deny: refuse,
        seal: sealApi,
        observe: (operation, target, write, source) => observeFile?.(operation, target, write, source),
    });
    installSqliteGuard({ roots, readRoots, deny: refuse, seal: sealApi, emit });
    const instrumentation = installInstrumentation(options.settings, emit, originPlugin, {
        manifestPath: options.manifestPath,
        resolutionManifestPath: options.resolutionManifestPath,
        runtimeId: identity.id,
        originPlugin,
    });
    instrumentation.protect(sealApi);
    observeFile = instrumentation.observeFile;
    const stopWorkers = installWorkerMonitor({ ...options, identity, emit, originPlugin });
    sealApi(workerThreads, "Worker", workerThreads.Worker, "worker_threads.Worker");
    sealApi(workerThreads.Worker.prototype, "constructor", workerThreads.Worker, "Worker.constructor");
    const getData = workerThreads.getEnvironmentData;
    const setData = workerThreads.setEnvironmentData;
    sealApi(workerThreads, "getEnvironmentData", (key) => key === workerMetadataKey ? undefined : getData(key), "Worker.getEnvironmentData");
    sealApi(workerThreads, "setEnvironmentData", (key, value) => {
        if (key === workerMetadataKey)
            refuse("worker-metadata", workerMetadataKey);
        return setData(key, value);
    }, "Worker.setEnvironmentData");
    syncBuiltinESMExports();
    let monitor;
    const dispose = Object.assign(() => {
        monitor?.stop();
        stopWorkers();
        instrumentation();
    }, {
        targets: instrumentation.targets,
        observeFile: instrumentation.observeFile,
        checkIntegrity: instrumentation.checkIntegrity,
        protect: instrumentation.protect,
    });
    Object.defineProperty(globalThis, runtimeKey, {
        value: Object.freeze({ identity, settings: options.settings }),
    });
    const handle = {
        identity,
        watch,
        instrumentation: dispose,
        ready: options.ready ?? Promise.resolve(),
        prepareAudit: close => stopWorkers.prepareAudit(close),
        auditCoverage: () => stopWorkers.auditCoverage(),
    };
    installedRuntime = Object.freeze(handle);
    if (identity.kind !== "yunzai" && options.settings.protect.targets.length) {
        monitor = new IntegrityMonitor(options.settings, () => ({ ...instrumentation.targets(), Global: globalThis }), emit, watch);
        monitor.start();
    }
    return handle;
}
/** 由 Node 子进程和 Worker 线程的同步预加载器调用。 */
export function installInheritedRuntime() {
    const readonly = (runtime) => Object.freeze({ identity: runtime.identity, ready: runtime.ready });
    if (installedRuntime)
        return readonly(installedRuntime);
    if (!isMainThread) {
        const metadata = getEnvironmentData(workerMetadataKey);
        if (!metadata)
            throw new Error(M.runtime.workerMetadataMissing);
        setEnvironmentData(workerMetadataKey, undefined);
        if (metadata.version !== 1 ||
            !(metadata.port instanceof MessagePort) ||
            !metadata.identity?.id ||
            typeof metadata.auditChannelNonce !== "string" ||
            !/^[a-f0-9]{48}$/.test(metadata.auditChannelNonce))
            throw new Error(M.runtime.workerMetadata);
        installSandboxResolution(metadata.resolutionManifestPath ?? metadata.manifestPath);
        const settings = parseSettings(metadata.settings);
        const identity = {
            ...metadata.identity,
            kind: "thread",
            pid: process.pid,
            threadId,
        };
        const transport = connectPort(metadata.port, settings, identity, metadata.auditChannelNonce, lifecycle);
        const handle = installRuntime({
            settings,
            identity,
            manifestPath: metadata.manifestPath,
            resolutionManifestPath: metadata.resolutionManifestPath,
            emit: transport,
        });
        try {
            metadata.port.postMessage({
                type: "runtime-ready",
                auditProtocol,
                generation: identity.generation,
                channelNonce: metadata.auditChannelNonce,
            });
        }
        catch {
            reportFailure(settings, identity, "worker-ready-delivery-failed");
        }
        return readonly(handle);
    }
    const filename = process.env.YUNZAI_GUARD_RUNTIME_MANIFEST;
    if (!filename)
        return undefined;
    installSandboxResolution(filename);
    const manifest = readManifest(filename);
    const identity = {
        id: randomUUID(),
        parentId: process.env.YUNZAI_GUARD_PARENT_RUNTIME,
        originPlugin: (process.env.YUNZAI_GUARD_ORIGIN_PLUGIN ?? "unknown")
            .replace(/[\r\n\0]/g, "")
            .slice(0, 128),
        generation: manifest.generation,
        kind: "node-process",
        pid: process.pid,
        observability: "js-entrypoints",
    };
    const transport = connectSocket(manifest, identity, lifecycle);
    return readonly(installRuntime({
        settings: manifest.settings,
        identity,
        manifestPath: filename,
        emit: transport.emit,
        ready: transport.ready,
    }));
}
//# sourceMappingURL=index.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("runtime/index.ts", { installRuntime, installInheritedRuntime })
