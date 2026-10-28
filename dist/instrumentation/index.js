import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import dns from "node:dns";
import http2 from "node:http2";
import childProcess from "node:child_process";
import diagnostics from "node:diagnostics_channel";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { setInterval, clearInterval } from "node:timers";
import { evaluatePolicy, GuardDeniedError } from "../config/policy.js";
import { prepareNodeLaunch, prepareSpawnOptions, snapshotLaunch, isDirectNodeLaunch, } from "../runtime/launch.js";
import { arrayIsArray, arraySlice, newWeakMap, weakMapSet, weakMapGet, weakMapDelete, objectFreeze, promiseReject, sameDescriptor, timestamp, newMap, mapGet, mapSet, mapSize, mapClear, } from "../protect/intrinsics.js";
import { cleanTarget, prepareFork, describeRequest, describeSocket, describeDatagram, describeCommand, describeFetch, describeListen, describeDns, describeUrl, describeFile, describeNative, filePath, } from "./descriptions.js";
import { M } from "../shared/messages.js";
const descriptor = Object.getOwnPropertyDescriptor;
const define = Object.defineProperty;
const apply = Reflect.apply;
const construct = Reflect.construct;
const getPrototype = Object.getPrototypeOf;
const clock = performance.now.bind(performance);
/** 同一插件对同一文件的同类审计记录的最短间隔。 */
const fileRepeatMs = 60000;
const spawnChannel = diagnostics.channel("tracing:child_process.spawn:start");
/** 空订阅者，仅用于取得诊断通道的发布函数。 */
const noop = () => { };
spawnChannel.subscribe(noop);
const publishSpawn = spawnChannel.publish;
spawnChannel.unsubscribe(noop);
/** 从调用栈中找出首个非 Guard 的插件目录名。 */
function stackPlugin() {
    const stack = new Error().stack ?? "";
    const matches = stack.matchAll(/[/\\]plugins[/\\]([^/\\\s:)]+)/g);
    for (const match of matches) {
        const name = match[1];
        if (name && name !== "yunzai-guard")
            return cleanTarget(name).slice(0, 128);
    }
    return undefined;
}
/**
 * 在 app.js 前安装，覆盖 JS 内置调用点及同步后的 ESM 绑定。
 * 原生代码、此前捕获的引用和外部程序不在此钩子的保护范围内。
 */
export function installInstrumentation(settings, emit, contextProvider, launchContext) {
    const installed = [];
    let inside = 0;
    let disposed = false;
    let timer;
    const launches = newWeakMap();
    const recentFiles = newMap();
    const spawnOptions = newWeakMap();
    /** 上报事件，传输异常不影响业务调用。 */
    function report(event) {
        try {
            emit(event);
        }
        catch {
            // 父进程断连由 worker 生命周期处理，不由这些 API 包装器处理。
        }
    }
    /** 返回当前调用的插件归因，未知时为 unknown。 */
    function attribution() {
        let plugin;
        try {
            plugin = contextProvider?.() ?? stackPlugin();
        }
        catch {
            plugin = undefined;
        }
        return plugin ? cleanTarget(plugin).slice(0, 128) : "unknown";
    }
    /** 评估事件并上报；非 audit 动作抛出拒绝错误。 */
    function inspect(description, plugin = attribution()) {
        const event = {
            kind: description.kind,
            operation: description.operation,
            target: description.target,
            plugin,
        };
        const decision = evaluatePolicy(settings, event);
        report({
            ...event,
            ...decision,
            target: cleanTarget(description.auditTarget ?? description.target),
            timestamp: timestamp(),
            details: {
                ...description.details,
                blocked: decision.action !== "audit",
                result: decision.action === "audit" ? "attempt" : "blocked",
            },
        });
        if (description.kind === "process" && decision.action === "audit")
            report({
                kind: "runtime",
                operation: description.details?.childMonitoring === "runtime-requested"
                    ? "node-runtime-requested"
                    : "external-runtime-unobservable",
                target: cleanTarget(description.auditTarget ?? description.target),
                plugin: event.plugin,
                action: "audit",
                timestamp: timestamp(),
            });
        if (decision.action !== "audit")
            throw new GuardDeniedError(description.operation, decision.ruleId);
    }
    /** 替换属性值并登记，供完整性检查与卸载使用。 */
    function replace(container, key, name, replacement) {
        const original = descriptor(container, key);
        if (!original || !("value" in original))
            throw new Error(M.instrumentation.target(name));
        const replacementDescriptor = { ...original, value: replacement };
        define(container, key, replacementDescriptor);
        installed.push({
            container,
            key,
            name,
            original,
            installed: replacementDescriptor,
            reported: false,
            prototype: getPrototype(container),
            restore: true,
        });
    }
    /** 包装函数入口：调用前检查，保留原有同步、回调与 Promise 语义。 */
    function wrap(container, key, name, describe, options = {}) {
        const original = container?.[key];
        if (typeof original !== "function")
            return;
        const { rejects = false, prepare: prepareArgs, snapshot: snapshotArgs } = options;
        const invoke = (thisArg, args, callable = original) => {
            if (inside || disposed)
                return apply(callable, thisArg, args);
            if (snapshotArgs)
                args = snapshotArgs(args);
            inside++;
            try {
                try {
                    inspect(describe(thisArg, args));
                }
                catch (error) {
                    if (rejects)
                        return promiseReject(error);
                    throw error;
                }
            }
            finally {
                inside--;
            }
            // 原生 API 可能同步调用用户回调，例如自定义 DNS 查询。
            // 这些回调仍须监控，不能将整个原生调用都视为可信。
            return apply(callable, thisArg, prepareArgs ? prepareArgs(args) : args);
        };
        const wrapped = function (...args) {
            return invoke(this, args);
        };
        // exec/execFile 有自定义 promisify 实现；原样复制会绕过包装器。
        const properties = Object.getOwnPropertyDescriptors(original);
        for (const property of Reflect.ownKeys(properties)) {
            if (property === "caller" || property === "arguments" || property === "prototype")
                continue;
            const entry = properties[property];
            if (property === promisify.custom && typeof entry.value === "function") {
                const custom = entry.value;
                const replacementDescriptor = {
                    configurable: entry.configurable,
                    enumerable: entry.enumerable,
                    /** Node 会给返回函数写入自引用标记，每次返回新函数，不交出已冻结的内部入口。 */
                    get() {
                        return function (...args) {
                            try {
                                return invoke(this, args, custom);
                            }
                            catch (error) {
                                return promiseReject(error);
                            }
                        };
                    },
                };
                define(wrapped, property, replacementDescriptor);
                installed.push({
                    container: wrapped,
                    key: property,
                    name: `${name}[util.promisify.custom]`,
                    original: entry,
                    installed: replacementDescriptor,
                    reported: false,
                    prototype: getPrototype(wrapped),
                    restore: false,
                });
            }
            else
                define(wrapped, property, entry);
        }
        replace(container, key, name, wrapped);
    }
    /** 构造器与直接调用都先检查；惰性全局访问器先固定为数据属性。 */
    function guardClass(container, key, name, describe) {
        const current = descriptor(container, key);
        if (!current)
            return;
        const target = ("value" in current ? current.value : container[key]);
        if (typeof target !== "function")
            return;
        if (!("value" in current))
            define(container, key, {
                value: target,
                writable: true,
                enumerable: current.enumerable,
                configurable: true,
            });
        const check = (args) => {
            if (inside || disposed)
                return;
            inside++;
            try {
                inspect(describe(args));
            }
            finally {
                inside--;
            }
        };
        replace(container, key, name, new Proxy(target, {
            /** 构造前检查。 */
            construct(target, args, newTarget) {
                check(args);
                return construct(target, args, newTarget);
            },
            /** 直接调用前检查。 */
            apply(target, thisArg, args) {
                check(args);
                return apply(target, thisArg, args);
            },
        }));
    }
    /** 按 monitor.files 记录业务文件访问。 */
    function observeFile(operation, target, write, source) {
        const mode = settings.monitor.files;
        if (inside || disposed || mode === "off" || (!write && mode !== "all"))
            return;
        const file = filePath(target);
        if (!file)
            return;
        inside++;
        try {
            const description = describeFile(operation, file, write, filePath(source));
            const plugin = attribution();
            const key = `${plugin}\0${operation}\0${file}`;
            const now = clock();
            const last = mapGet(recentFiles, key);
            // 仅省略重复的 audit 记录；deny/restart 每次都要执行。
            if (last !== undefined &&
                now - last < fileRepeatMs &&
                evaluatePolicy(settings, { kind: "filesystem", operation, target: file, plugin }).action ===
                    "audit")
                return;
            if (mapSize(recentFiles) >= 1024)
                mapClear(recentFiles);
            mapSet(recentFiles, key, now);
            inspect(description, plugin);
        }
        finally {
            inside--;
        }
    }
    /** 检查已安装的包装是否被替换，变化时上报一次。 */
    function checkIntegrity() {
        if (disposed || !settings.protect.enabled || !settings.protect.monitorInstrumentation)
            return;
        for (const item of installed) {
            let changed = true;
            try {
                changed =
                    getPrototype(item.container) !== item.prototype ||
                        !sameDescriptor(descriptor(item.container, item.key), item.installed);
            }
            catch {
                // Proxy 抛错或描述符被替换，同样属于可观察的完整性失败。
            }
            if (!changed) {
                item.reported = false;
                continue;
            }
            if (item.reported)
                continue;
            item.reported = true;
            const event = {
                kind: "integrity",
                operation: "instrumentation-change",
                target: item.name,
                plugin: attribution(),
                timestamp: timestamp(),
                details: { blocked: false, detection: "after-change" },
            };
            const decision = evaluatePolicy(settings, event);
            report({
                ...event,
                ...decision,
                action: decision.ruleId ? decision.action : settings.protect.action,
            });
        }
    }
    const dispose = Object.assign(() => {
        if (disposed)
            return;
        disposed = true;
        if (timer)
            clearInterval(timer);
        for (const item of installed.reverse()) {
            // 正常卸载时，不覆盖安装后其他代码所做的修改。
            if (item.restore && sameDescriptor(descriptor(item.container, item.key), item.installed)) {
                if (item.original)
                    define(item.container, item.key, item.original);
                else
                    delete item.container[item.key];
            }
        }
        syncBuiltinESMExports();
    }, {
        targets: () => ({ http, https, http2, net, tls, dgram, dns, childProcess, globalThis }),
        observeFile,
        checkIntegrity,
        /** 封印已安装的包装槽，之后卸载时不再恢复。 */
        protect(seal) {
            for (const item of installed) {
                if (!("value" in item.installed))
                    continue;
                seal(item.container, item.key, item.installed.value, item.name);
            }
            for (const item of installed) {
                item.installed = descriptor(item.container, item.key);
                // 退出时只停用行为审计；永久自保护入口不恢复为未包装状态。
                item.restore = false;
            }
        },
    });
    try {
        for (const [module, scheme] of [
            [http, "http:"],
            [https, "https:"],
        ]) {
            for (const operation of ["request", "get"])
                wrap(module, operation, `${scheme.slice(0, -1)}.${operation}`, (_this, args) => describeRequest(`${scheme.slice(0, -1)}.${operation}`, args, scheme));
        }
        // 直接 new ClientRequest() 不会调用导出的 request/get 函数。
        guardClass(http, "ClientRequest", "http.ClientRequest", args => describeRequest("http.ClientRequest", args, "http:"));
        wrap(http2, "connect", "http2.connect", (_this, args) => describeUrl("http2.connect", args, "https:"));
        for (const [key, protocol] of [
            ["WebSocket", "wss:"],
            ["EventSource", "https:"],
        ])
            guardClass(globalThis, key, `globalThis.${key}`, args => describeUrl(key, args, protocol));
        wrap(net.Server.prototype, "listen", "net.Server.prototype.listen", (_this, args) => describeListen("socket.listen", args, "tcp://"));
        wrap(dgram.Socket.prototype, "bind", "dgram.Socket.prototype.bind", (_this, args) => describeListen("udp.bind", args, "udp://"));
        const queries = [
            "resolve",
            "resolve4",
            "resolve6",
            "resolveAny",
            "resolveCaa",
            "resolveCname",
            "resolveMx",
            "resolveNaptr",
            "resolveNs",
            "resolvePtr",
            "resolveSoa",
            "resolveSrv",
            "resolveTxt",
            "reverse",
        ];
        for (const [container, label, rejects] of [
            [dns, "dns", false],
            [dns.Resolver.prototype, "dns.Resolver.prototype", false],
            [dns.promises, "dns.promises", true],
            [dns.promises.Resolver.prototype, "dns.promises.Resolver.prototype", true],
        ])
            for (const query of queries)
                wrap(container, query, `${label}.${query}`, (_this, args) => describeDns(`dns.${query}`, args), { rejects });
        // 原生扩展加载后其内部 I/O 不经过 JS 入口，只能记录加载本身及归因。
        wrap(process, "dlopen", "process.dlopen", (_this, args) => describeNative(args));
        // net.connect/createConnection 总会调用 Socket#connect，只在这一处检查，避免同一连接记录两次。
        wrap(net.Socket.prototype, "connect", "net.Socket.prototype.connect", (_this, args) => describeSocket("socket.connect", args, "tcp://"));
        wrap(tls, "connect", "tls.connect", (_this, args) => describeSocket("tls.connect", args, "tls://"));
        wrap(dgram.Socket.prototype, "connect", "dgram.Socket.prototype.connect", (_this, args) => describeSocket("udp.connect", args, "udp://"));
        wrap(dgram.Socket.prototype, "send", "dgram.Socket.prototype.send", (socket, args) => describeDatagram(socket, args));
        wrap(globalThis, "fetch", "globalThis.fetch", (_this, args) => describeFetch(args), {
            rejects: true,
        });
        const originalPublish = descriptor(spawnChannel, "publish");
        const guardedPublish = function (data) {
            const options = data?.options;
            if (options && weakMapGet(spawnOptions, options)) {
                objectFreeze(options.args);
                objectFreeze(options.envPairs);
                objectFreeze(options);
            }
            apply(publishSpawn, this, [data]);
        };
        define(spawnChannel, "publish", { value: guardedPublish, writable: true, configurable: true });
        installed.push({
            container: spawnChannel,
            key: "publish",
            name: "diagnostics.child_process.spawn.publish",
            original: originalPublish,
            installed: descriptor(spawnChannel, "publish"),
            reported: false,
            prototype: getPrototype(spawnChannel),
            restore: true,
        });
        const rawSpawn = childProcess.ChildProcess.prototype.spawn;
        replace(childProcess.ChildProcess.prototype, "spawn", "ChildProcess.prototype.spawn", function (input) {
            if (!input || typeof input !== "object" || arrayIsArray(input) || disposed)
                return apply(rawSpawn, this, [input]);
            const options = prepareSpawnOptions(input, launchContext);
            const token = options.env;
            const known = token && typeof token === "object" && weakMapGet(launches, token);
            if (known)
                weakMapDelete(launches, token);
            if (!known) {
                const args = [
                    options.file,
                    arrayIsArray(options.args) ? arraySlice(options.args, 1) : [],
                    { cwd: options.cwd },
                ];
                const description = describeCommand("spawn", args);
                description.details = {
                    ...description.details,
                    childMonitoring: launchContext?.manifestPath && isDirectNodeLaunch("spawn", args)
                        ? "runtime-requested"
                        : "creation-only",
                };
                inspect(description);
            }
            weakMapSet(spawnOptions, options, true);
            return apply(rawSpawn, this, [options]);
        });
        for (const operation of [
            "exec",
            "execFile",
            "spawn",
            "fork",
            "execSync",
            "execFileSync",
            "spawnSync",
        ])
            wrap(childProcess, operation, `child_process.${operation}`, (_this, args) => {
                const description = describeCommand(operation, args);
                description.details = {
                    ...description.details,
                    childMonitoring: launchContext?.manifestPath && isDirectNodeLaunch(operation, args)
                        ? "runtime-requested"
                        : "creation-only",
                };
                return description;
            }, {
                prepare: args => {
                    const prepared = launchContext
                        ? prepareNodeLaunch(operation, args, launchContext)
                        : operation === "fork"
                            ? prepareFork(args)
                            : args;
                    const at = arrayIsArray(prepared[1]) || (prepared[1] == null && prepared.length >= 3) ? 2 : 1;
                    const options = prepared[at];
                    if (!options || typeof options !== "object" || arrayIsArray(options))
                        return prepared;
                    const token = options.env;
                    if (token && typeof token === "object")
                        weakMapSet(launches, token, true);
                    return prepared;
                },
                snapshot: args => snapshotLaunch(operation, args),
            });
        syncBuiltinESMExports();
        if (settings.protect.enabled && settings.protect.monitorInstrumentation) {
            timer = setInterval(checkIntegrity, settings.protect.intervalMs);
            timer.unref();
        }
        report({
            kind: "guard",
            operation: "instrumentation-installed",
            target: "builtin-js-entrypoints",
            timestamp: timestamp(),
            details: {
                targets: installed.map(item => item.name),
                attribution: "async-context-or-stack-hint",
                boundary: "javascript",
            },
        });
        return dispose;
    }
    catch (error) {
        dispose();
        throw error;
    }
}
//# sourceMappingURL=index.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("instrumentation/index.ts", { installInstrumentation })
