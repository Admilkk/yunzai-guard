import { randomBytes, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { registerHooks } from "node:module";
import { isMainThread } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import { contextKey, projectId, root } from "../shared/identity.js";
import { parseSettings } from "../config/index.js";
import { installRuntime } from "./index.js";
import { ensureWorkerTransport } from "./worker-transport.js";
import { trackCoverage } from "./reporter.js";
import { installSandboxResolution } from "../sandbox/resolution.js";
import { IntegrityMonitor } from "../monitor/integrity.js";
import { PluginMonitor } from "../monitor/plugin.js";
import { installModuleAudit } from "../monitor/modules.js";
import { runtimeEventDecision } from "./policy.js";
import { decodeModuleSource } from "../monitor/source.js";
import { SandboxDispatcher } from "../plugin-sandbox/dispatcher.js";
import { NativePluginLoader } from "../native-sandbox/loader.js";
import { detectCoreProfile, instrumentCoreLoaderSource, requiresCoreLoaderBridge, } from "../monitor/loader.js";
import { shutdownBootstrapResources } from "../host/bootstrap/shutdown.js";
import { AuditSender } from "../audit/sender.js";
import { createAuditDeadline, parseAuditFrame } from "../audit/protocol.js";
import { RuntimeBus } from "./bus.js";
import { attachGuardPlugin } from "./guard-plugin.js";
import { LoaderHooks } from "../monitor/loader-hooks.js";
import { EventCoalescer } from "./coalesce.js";
import { seal, registerModule } from "../protect/objects.js";
import { M } from "../shared/messages.js";
/** Guard 安装目录。 */
const guardRoot = fileURLToPath(new URL("../../", import.meta.url));
/** 主人命令对应的宿主控制指令。 */
const guardCommandTypes = Object.freeze({
    update: "update-request",
    "force-update": "update-force-request",
    rollback: "rollback-request",
    login: "login-link-request",
});
// 共享运行时根据父进程提供的元数据安装嵌套 Worker 监控。
// 仅 Yunzai 主线程执行宿主握手及核心生命周期桥接。
if (isMainThread) {
    let outputClosed = false;
    // eslint-disable-next-line prefer-const -- 先被回调引用，之后才赋值
    let requestOutputStop;
    for (const stream of [process.stdout, process.stderr])
        stream.on("error", (error) => {
            if (error.code !== "EPIPE") {
                // 保留未处理流错误的原行为，不覆盖业务监听器。
                if (stream.listenerCount("error") === 1)
                    throw error;
                return;
            }
            if (outputClosed)
                return;
            outputClosed = true;
            requestOutputStop?.();
        });
    // Windows 显式启动器下业务进程与宿主共用控制台，Ctrl+C 也会直接送到这里；交由宿主有序停止，
    // 否则业务进程被立即结束，宿主无法确认清理而熔断。宿主断开时业务进程仍会随之退出。
    if (process.platform === "win32")
        for (const signal of ["SIGINT", "SIGBREAK"])
            process.on(signal, () => { });
    await ensureWorkerTransport();
    const rawExit = process.exit.bind(process);
    const ipcSend = process.send?.bind(process);
    if (!ipcSend || !process.connected)
        throw new Error(M.runtime.workerIpc);
    const nonce = randomUUID();
    const hello = await new Promise((resolve, reject) => {
        const configuredTimeout = Number(process.env.YUNZAI_GUARD_HANDSHAKE_TIMEOUT);
        const timeoutMs = Number.isSafeInteger(configuredTimeout) &&
            configuredTimeout >= 100 &&
            configuredTimeout <= 120000
            ? configuredTimeout
            : 5000;
        const timeout = setTimeout(() => reject(new Error(M.runtime.handshakeTimeout)), timeoutMs);
        const listener = (message) => {
            const value = message;
            if (value?.type !== "worker-handshake" ||
                value.nonce !== nonce ||
                value.projectId !== projectId)
                return;
            if (!Number.isSafeInteger(value.generation) || Number(value.generation) < 1)
                return;
            if (typeof value.controlKey !== "string" || !/^[a-f0-9]{64}$/.test(value.controlKey))
                return;
            clearTimeout(timeout);
            process.off("message", listener);
            resolve({
                generation: Number(value.generation),
                controlKey: value.controlKey,
                settings: value.settings,
                auditChannelNonce: typeof value.auditChannelNonce === "string" &&
                    /^[a-f0-9]{48}$/.test(value.auditChannelNonce)
                    ? value.auditChannelNonce
                    : undefined,
                sandboxSources: Array.isArray(value.sandboxSources)
                    ? value.sandboxSources
                    : [],
                runtimeManifest: typeof value.runtimeManifest === "string" ? value.runtimeManifest : undefined,
            });
        };
        process.on("message", listener);
        ipcSend({ type: "preload-hello", nonce, projectId, pid: process.pid });
    });
    installSandboxResolution(hello.runtimeManifest ?? process.env.YUNZAI_GUARD_RUNTIME_MANIFEST);
    const settings = parseSettings(hello.settings);
    if (hello.sandboxSources.length !==
        settings.pluginSandbox.plugins.filter(item => item.enabled).length ||
        hello.sandboxSources.some((item, index) => item.id !== settings.pluginSandbox.plugins.filter(item => item.enabled)[index]?.id))
        throw new Error(M.runtime.sandboxHandshake);
    const storage = new AsyncLocalStorage();
    const run = (name, callback) => storage.run(name, callback);
    // 仍可观察旧测试及旧父进程，但不能签发有序的宿主回执。
    const auditChannelNonce = hello.auditChannelNonce ?? randomBytes(24).toString("hex");
    let auditClose;
    let auditSeal;
    let auditResultReceived = false;
    let invalidAuditReplies = 0;
    const auditSender = new AuditSender({
        generation: hello.generation,
        maxQueue: settings.audit.maxQueue,
        channelNonce: auditChannelNonce,
        completion: hello.auditChannelNonce ? "hop" : "callback",
        isConnected: () => process.connected,
        /** 经 IPC 发送审计帧，写入完成后恢复发送。 */
        write(frame, callback) {
            return ipcSend({ ...frame, pid: process.pid }, error => {
                callback(error);
                // IPC 没有公开的 drain 事件；实际写入回调是下一次发送机会。
                auditSender.resume();
            });
        },
    });
    const coalescer = new EventCoalescer({
        windowMs: () => settings.audit.coalesceMs,
        maxKeys: 4096,
        forward: (event, critical) => auditSender.offer(event, critical).accepted,
    });
    const bus = new RuntimeBus({
        generation: hello.generation,
        pid: process.pid,
        controlKey: hello.controlKey,
        connected: () => process.connected,
        offer: (event, critical) => coalescer.offer(event, critical),
        write: (message, done) => ipcSend(message, done),
        fail: () => {
            rawExit(1);
        },
    });
    const context = Object.freeze({
        generation: hello.generation,
        settings,
        send: bus.send,
    });
    registerModule("runtime-context", {
        ...context,
        run,
        audit: bus.audit,
        command: bus.command,
        notify: bus.notify,
    });
    requestOutputStop = () => bus.command({ type: "stop-request", reason: "output-pipe-closed" });
    if (outputClosed)
        requestOutputStop();
    Object.defineProperty(globalThis, contextKey, { value: context });
    const emit = bus.audit;
    const nestedCoverage = trackCoverage(emit, "primary-control", () => runtime.auditCoverage().nestedCoverage);
    const sandboxDispatcher = new SandboxDispatcher(root, settings, hello.sandboxSources, emit, (id, text) => console.info(M.runtime.sandboxTag(id), text));
    await sandboxDispatcher.ready();
    const runtime = installRuntime({
        settings,
        emit,
        contextProvider: () => storage.getStore(),
        manifestPath: hello.runtimeManifest ?? process.env.YUNZAI_GUARD_RUNTIME_MANIFEST,
        identity: {
            id: `yunzai-${hello.generation}-${process.pid}`,
            kind: "yunzai",
            generation: hello.generation,
            pid: process.pid,
            originPlugin: "unknown",
            observability: "js-entrypoints",
        },
    });
    const instrumentation = runtime.instrumentation;
    let moduleAudit;
    if (settings.protect.enabled) {
        try {
            moduleAudit = installModuleAudit({
                root,
                guardRoot,
                contextPlugin: () => storage.getStore(),
                originalFunction: value => plugins.originalFunction(value),
                intervalMs: settings.protect.intervalMs,
                watch: runtime.watch,
                emit: event => emit({ ...event, ...runtimeEventDecision(settings, event) }),
            });
        }
        catch {
            emit({
                kind: "coverage",
                operation: "module-audit-unavailable",
                target: "plugin-modules",
                action: "audit",
                details: { reason: "installation-failed", coverage: "partial" },
            });
        }
    }
    const roots = {};
    const monitor = new IntegrityMonitor(settings, () => {
        const actual = Reflect.get(globalThis, "Bot");
        return {
            ...instrumentation.targets(),
            ...roots,
            Global: globalThis,
            Bot: actual?.bot ?? actual,
        };
    }, emit, runtime.watch);
    let monitoring = false;
    let currentBot;
    let shuttingDown = false;
    /** 接管核心 Bot：重定向重启与退出，并在上线后开始监控。 */
    function attachBot(value) {
        if (value === currentBot)
            return;
        currentBot = value;
        const bot = value.bot ?? value;
        const pendingExit = () => new Promise(() => { });
        seal(bot, "restart", () => {
            bus.command({ type: "restart-request" });
            return pendingExit();
        }, "Bot.restart.guard");
        seal(bot, "exit", () => {
            bus.command({ type: "stop-request" });
            return pendingExit();
        }, "Bot.exit.guard");
        bot.once("online", () => {
            bus.notify({ type: "worker-online" });
            reportMonitoring();
            for (const row of monitor.coverage().targets)
                if (row.state === "pending" || row.state === "inspection-failed")
                    emit({
                        kind: "coverage",
                        operation: "protected-target-unavailable",
                        target: row.target,
                        action: "audit",
                    });
        });
        if (!monitoring) {
            monitor.capture();
            monitor.start();
            monitoring = true;
        }
    }
    Object.defineProperty(globalThis, "Bot", {
        configurable: false,
        get: () => currentBot,
        set: attachBot,
    });
    // 只对已知核心导出点插入内存桥接；磁盘核心文件保持原样。
    const bridgeKey = Symbol.for("yunzai.guard.loader.bridge.v1");
    const coreProfile = detectCoreProfile(root);
    const coreLoaderUrl = pathToFileURL(path.join(root, coreProfile.loaderFile)).href;
    const plugins = new PluginMonitor({ settings, run }, emit, () => monitor.check(), runtime.watch, () => storage.getStore());
    const nativePlugins = new NativePluginLoader(root, settings, emit, () => bus.command({ type: "restart-request" }));
    /** 汇总监控覆盖并发送给宿主，超长时截断插件条目。 */
    function reportMonitoring() {
        const report = {
            targets: monitor
                .coverage()
                .targets.map(({ state, reason }) => ({ state, ...(reason ? { reason } : {}) })),
            plugins: plugins.snapshot(),
        };
        // Linux 文件名可含控制字符；限制序列化数据包大小，而非 UTF-16 长度。
        while (Buffer.byteLength(JSON.stringify(report)) > 48000 && report.plugins.entries.length) {
            report.plugins.entries.pop();
            report.plugins.truncated = true;
        }
        bus.notify({ type: "monitor-report", report });
    }
    const reportTimer = setInterval(reportMonitoring, 2000);
    reportTimer.unref();
    /** 首次拿到核心加载器时接入钩子，由外到内：Guard 自有插件、插件监控、原生沙箱。 */
    function attachLoader(loader) {
        if (roots.PluginsLoader)
            return loader;
        roots.PluginsLoader = loader;
        const hooks = LoaderHooks.of(loader);
        attachGuardPlugin(hooks, {
            entry: path.join(guardRoot, "index.js"),
            loaderDirectory: path.dirname(path.join(root, coreProfile.loaderFile)),
            command: command => bus.command({ type: guardCommandTypes[command] }),
            dispatch: event => sandboxDispatcher.dispatch(event),
        });
        plugins.attach(loader);
        nativePlugins.attach(loader);
        hooks.lock();
        return loader;
    }
    Object.defineProperty(globalThis, bridgeKey, {
        value: Object.freeze({
            loader: attachLoader,
            construct: (constructor, args, name) => plugins.construct(constructor, args, name),
            testRule: (regexp, text) => nativePlugins.testRule(regexp, text),
            ruleArgs: (fn, regexp, event) => nativePlugins.ruleArgs(fn, regexp, event),
        }),
    });
    registerHooks({
        /** 解析模块路径，保持原行为。 */
        resolve(url, hookContext, nextResolve) {
            const result = nextResolve(url, hookContext);
            moduleAudit?.resolve(hookContext.parentURL, result.url);
            return result;
        },
        /** 加载核心加载器源码时插入内存桥接。 */
        load(url, hookContext, nextLoad) {
            // 核心可选的 #miao 等导入发生在 loader.importPlugin 之前。
            // 已选定隔离的插件不能经此旁路在核心内执行。
            if (url.startsWith("file:") &&
                settings.pluginSandbox.native.plugins.some(item => item.enabled)) {
                const filename = fs.realpathSync.native(fileURLToPath(url));
                for (const item of settings.pluginSandbox.native.plugins) {
                    if (!item.enabled)
                        continue;
                    const directory = path.join(root, "plugins", item.id);
                    const relative = path.relative(directory, filename);
                    if (!relative ||
                        (!path.isAbsolute(relative) &&
                            relative !== ".." &&
                            !relative.startsWith(`..${path.sep}`)))
                        throw new Error(M.runtime.nativeImport(item.id));
                }
            }
            const result = nextLoad(url, hookContext);
            if (url.split("?")[0] !== coreLoaderUrl) {
                if (!moduleAudit)
                    return result;
                const instrumented = moduleAudit.instrument(url, result.format ?? undefined, result.source);
                if (instrumented !== undefined)
                    return { ...result, source: instrumented };
                return result;
            }
            const source = decodeModuleSource(result.source);
            const nativeEnabled = settings.pluginSandbox.native.plugins.some(item => item.enabled);
            const instrumented = source === undefined
                ? undefined
                : instrumentCoreLoaderSource(source, nativeEnabled, coreProfile);
            if (instrumented === undefined) {
                emit({
                    kind: "coverage",
                    operation: "plugin-monitor-unavailable",
                    target: "core-loader",
                    action: "audit",
                    details: { reason: "unsupported-loader", core: coreProfile.id },
                });
                if (!requiresCoreLoaderBridge(settings))
                    return result;
                if (nativeEnabled && !coreProfile.nativeSandbox)
                    throw new Error(M.runtime.nativeCoreUnsupported(coreProfile.id));
                throw new Error(M.runtime.loaderExport);
            }
            return { ...result, source: instrumented };
        },
    });
    process.on("message", (message) => {
        const value = message;
        if (value?.auditProtocol !== undefined) {
            const frame = parseAuditFrame(value);
            if (!frame ||
                frame.generation !== hello.generation ||
                frame.channelNonce !== auditChannelNonce) {
                invalidAuditReplies++;
                return;
            }
            if (frame.type === "audit-hop-ack") {
                if (!auditSender.ack(frame))
                    invalidAuditReplies++;
            }
            else if (frame.type === "audit-prepare-flush") {
                if (auditClose && auditClose.nonce !== frame.closeNonce)
                    invalidAuditReplies++;
                else if (!auditClose) {
                    auditClose = {
                        nonce: frame.closeNonce,
                        deadline: createAuditDeadline(frame.remainingBudgetMs),
                    };
                    runtime.prepareAudit(auditClose);
                }
            }
            else if (frame.type === "audit-flush-result" &&
                auditClose &&
                auditSeal &&
                frame.closeNonce === auditClose.nonce &&
                frame.cutoff === auditSeal.lastSentSeq &&
                frame.evidence === "host-append-completed")
                auditResultReceived = true;
            else
                invalidAuditReplies++;
            return;
        }
        if (value?.generation !== hello.generation)
            return;
        const bot = currentBot?.bot ?? currentBot;
        if (value.type === "invoke-bot-restart" && bot)
            void bot.restart();
        if (value.type === "update-notice" &&
            bot &&
            typeof value.text === "string" &&
            value.text.length <= 4000 &&
            typeof bot.sendMasterMsg === "function")
            void Promise.resolve(bot.sendMasterMsg(value.text, undefined, 0)).catch(() => { });
        if (value.type === "shutdown" && !shuttingDown) {
            shuttingDown = true;
            monitor.stop();
            moduleAudit?.close();
            clearInterval(reportTimer);
            const shutdownDeadline = auditClose?.deadline ?? createAuditDeadline(settings.shutdownTimeout);
            let shutdownExitCode = 0;
            void (async () => {
                await sandboxDispatcher.close();
                await nativePlugins.close();
                if (bot) {
                    const originalRedisClient = () => globalThis.redis;
                    await shutdownBootstrapResources(bot, originalRedisClient(), Math.max(1, shutdownDeadline.remainingMs() - 100), originalRedisClient);
                }
            })()
                .catch(error => {
                shutdownExitCode = 1;
                console.error(M.runtime.coreExitCleanup, error);
            })
                .finally(async () => {
                // 仅受信生命周期清理可封账主来源；审计等待共用该截止时间。
                try {
                    coalescer.close();
                    runtime.instrumentation();
                    if (auditClose) {
                        auditSeal = await auditSender.seal({
                            ...auditClose,
                            nestedCoverage: nestedCoverage(),
                        });
                        auditSeal = {
                            ...auditSeal,
                            sourceCounters: {
                                ...auditSeal.sourceCounters,
                                invalidReplies: Math.min(Number.MAX_SAFE_INTEGER, auditSeal.sourceCounters.invalidReplies + invalidAuditReplies),
                            },
                        };
                        ipcSend({ ...auditSeal, pid: process.pid }, () => { });
                        while (!auditResultReceived &&
                            process.connected &&
                            shutdownDeadline.remainingMs() > 0)
                            await new Promise(resolve => setTimeout(resolve, Math.min(5, shutdownDeadline.remainingMs())));
                    }
                }
                catch {
                    // 投递缺失只代表来源不完整，不能改变默认业务退出行为。
                }
                finally {
                    auditSender.dispose();
                    rawExit(shutdownExitCode);
                }
            });
        }
    });
    process.once("exit", () => {
        if (auditClose && !auditSeal)
            try {
                auditSeal = auditSender.sealNow({
                    nonce: auditClose.nonce,
                    nestedCoverage: nestedCoverage(),
                });
                auditSeal = {
                    ...auditSeal,
                    sourceCounters: {
                        ...auditSeal.sourceCounters,
                        invalidReplies: Math.min(Number.MAX_SAFE_INTEGER, auditSeal.sourceCounters.invalidReplies + invalidAuditReplies),
                    },
                };
                ipcSend({ ...auditSeal, pid: process.pid }, () => { });
            }
            catch {
                // 自然 process.exit 保持同步；宿主独立观察缺失的封账。
            }
        auditSender.dispose();
    });
    process.once("disconnect", () => rawExit(1));
    bus.notify({ type: "preload-ready" });
    reportMonitoring();
}
//# sourceMappingURL=worker-preload.js.map