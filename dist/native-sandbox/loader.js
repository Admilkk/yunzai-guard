import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { NativePluginClient, snapshotEvent } from "./client.js";
import { randomUUID } from "node:crypto";
import { validateNativeDescriptor } from "./validation.js";
import { NativeRegistrationBudget } from "./registrations.js";
import { parseNativePriority } from "./priority.js";
import { M } from "../shared/messages.js";
import { detectCoreProfile } from "../monitor/loader.js";
const metadataKeys = new Set([
    "name",
    "dsc",
    "event",
    "priority",
    "rule",
    "task",
    "handler",
    "namespace",
]);
const forbiddenMethods = new Set(["constructor", "__proto__", "prototype", "then"]);
/** 校验为普通对象。 */
function row(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(M.nativeSandbox.pluginMetadata);
    return value;
}
/** 在原加载器导入选中插件源码前，先确定原生进程执行路径。 */
export class NativePluginLoader {
    root;
    settings;
    emit;
    restart;
    clients = new Map();
    loadedFiles = new Map();
    failedPlugins = new Set();
    matchers = new WeakMap();
    ruleCalls = new WeakMap();
    ruleMarkers = new WeakMap();
    messageScope = new AsyncLocalStorage();
    closedScopes = new WeakSet();
    registrations = new NativeRegistrationBudget();
    loader;
    originalUnload;
    /** 创建原生插件加载器。 */
    constructor(root, settings, emit, restart) {
        this.root = root;
        this.settings = settings;
        this.emit = emit;
        this.restart = restart;
    }
    /** 返回插件的沙箱配置。 */
    configuration(name) {
        const directory = name.split("/")[0];
        return this.settings.pluginSandbox.native.plugins.find(config => config.enabled && config.id === directory);
    }
    /** 取得或创建插件的沙箱客户端。 */
    client(name) {
        const config = this.configuration(name);
        if (!config)
            throw new Error(M.nativeSandbox.notConfigured);
        if (this.failedPlugins.has(config.id))
            throw new Error(M.nativeSandbox.disabledAfterFailure);
        let client = this.clients.get(config.id);
        if (!client) {
            client = new NativePluginClient(this.root, config, this.settings, this.emit, () => Reflect.get(globalThis, "redis"), () => this.retire(config.id), this.restart);
            this.clients.set(config.id, client);
        }
        return client;
    }
    /** 退役插件的沙箱会话。 */
    async retire(id) {
        this.failedPlugins.add(id);
        const affected = new Set(this.loadedFiles.get(id) ?? []);
        for (const item of (this.loader?.priority ?? []))
            if (this.configuration(item.key)?.id === id)
                affected.add(item.key);
        const results = await Promise.allSettled([...affected].map(key => Reflect.apply(this.originalUnload, this.loader, [key])));
        if (results.some(result => result.status === "rejected"))
            throw new Error(M.nativeSandbox.retireFailed);
        this.loadedFiles.delete(id);
        this.registrations.release(id);
    }
    /** 在沙箱中测试规则。 */
    async testRule(regexp, text) {
        const match = this.matchers.get(regexp);
        return match ? match(text) : regexp.test(text);
    }
    /** 生成规则方法的调用参数。 */
    ruleArgs(fn, regexp, event) {
        const rule = this.ruleMarkers.get(regexp);
        if (rule) {
            const marker = Object.freeze({});
            this.ruleCalls.set(marker, rule);
            return [event, marker];
        }
        return (fn?.length ?? 0) >= 2 ? [event, regexp.exec(String(event.msg)) || undefined] : [event];
    }
    /** 释放消息处理期间创建的实例。 */
    async releaseInstances(scope) {
        this.closedScopes.add(scope);
        const groups = new Map();
        for (const item of scope.values()) {
            const entries = groups.get(item.client) ?? [];
            entries.push(item);
            groups.set(item.client, entries);
        }
        const released = await Promise.allSettled([...groups].map(async ([client, entries]) => {
            for (let index = 0; index < entries.length; index += 16)
                await client.releaseInstances(entries.slice(index, index + 16).map(({ classId, instanceId }) => ({
                    classId,
                    instanceId,
                })));
        }));
        scope.clear();
        if (released.some(item => item.status === "rejected")) {
            await Promise.allSettled([...groups.keys()].map(client => client.close()));
            for (const client of groups.keys())
                this.emit({
                    kind: "plugin-sandbox",
                    plugin: client.config.id,
                    operation: "native.cleanup-unconfirmed",
                    target: client.config.id,
                    action: "restart",
                    details: { reason: "message-instance-release" },
                });
            throw new Error(M.nativeSandbox.instanceCleanup);
        }
    }
    /** 为沙箱插件类生成核心可用的构造器代理。 */
    constructorProxy(client, descriptor, file) {
        validateNativeDescriptor(descriptor);
        if (!descriptor ||
            typeof descriptor.id !== "string" ||
            descriptor.id.length > 512 ||
            !Array.isArray(descriptor.methods) ||
            descriptor.methods.length > 257)
            throw new Error(M.nativeSandbox.classDescriptor);
        for (const method of descriptor.methods)
            if (typeof method !== "string" || method.length > 128 || forbiddenMethods.has(method))
                throw new Error(M.nativeSandbox.method);
        let metadata = row(descriptor.metadata);
        const base = Reflect.get(globalThis, "plugin");
        if (typeof base !== "function")
            throw new Error(M.nativeSandbox.pluginBase);
        const owner = this;
        const instances = new Set();
        const namespace = `guard-native-${randomUUID()}`;
        let initialized = false;
        const invoke = async (instance, method, args, handle, handler = false, scheduled = false) => {
            if (scheduled)
                client.consumeTask();
            const initializing = method === "init" && !initialized && !handle && !instance.e;
            if (initializing)
                initialized = true;
            const event = handler && args?.[0] && typeof args[0] === "object" ? args[0] : instance.e;
            const hasEvent = !!args?.length && args[0] === event;
            const values = args ? (hasEvent ? args.slice(1) : [...args]) : undefined;
            const rule = hasEvent && values?.length === 1 && values[0] && typeof values[0] === "object"
                ? owner.ruleCalls.get(values[0])
                : undefined;
            if (rule && (rule.client !== client || rule.classId !== descriptor.id))
                throw new Error(M.nativeSandbox.ruleMethod);
            const scope = owner.messageScope.getStore();
            let instanceId;
            if (scope &&
                !owner.closedScopes.has(scope) &&
                event &&
                method !== "init" &&
                method !== "onUnload") {
                const existing = scope.get(instance);
                if (existing && (existing.client !== client || existing.classId !== descriptor.id))
                    throw new Error(M.nativeSandbox.classDescriptor);
                instanceId = existing?.instanceId;
                if (!instanceId) {
                    if (scope.size >= 4096)
                        throw new Error(M.nativeSandbox.messageInstances);
                    instanceId = randomUUID();
                    scope.set(instance, { client, classId: descriptor.id, instanceId });
                }
            }
            const context = !handler &&
                !hasEvent &&
                args?.length === 1 &&
                args[0] &&
                typeof args[0] === "object" &&
                args[0].$type === "NativeContext"
                ? row(args[0])
                : undefined;
            const reject = handler && typeof values?.at(-1) === "function"
                ? values.pop()
                : undefined;
            const result = row(await client.request(handle ? "native-callback" : "native-call", {
                classId: descriptor.id,
                ...(instanceId ? { instanceId } : {}),
                ...(rule ? { ruleIndex: rule.ruleIndex } : {}),
                ...(handle ? { handle } : { method }),
                // 核心将当前事件作为首个参数，broker 仅提供值快照
                // 及该事件专属的回复能力，不序列化活动宿主事件。
                ...(context
                    ? { contextHandle: context.id }
                    : !rule && values && (hasEvent ? { eventArgs: values } : { args: values })),
                ...(reject ? { handlerReject: true } : {}),
            }, event, reject ? { handlerReject: reject } : undefined));
            if (result.metadata) {
                const updated = validateNativeDescriptor({
                    ...descriptor,
                    metadata: result.metadata,
                    ...(initializing && result.methods !== undefined ? { methods: result.methods } : {}),
                });
                // 仅 init 可修改核心即将安装的资源；后续消息
                // 修改私有元数据时，不能扣减仍在运行的宿主任务账本。
                if (initializing) {
                    this.registrations.update(client.config.id, file, updated);
                    descriptor = updated;
                    installMethods(descriptor.methods);
                }
                metadata = updated.metadata;
                if (initializing)
                    for (const current of instances)
                        assign(current);
            }
            return result.result;
        };
        const decode = (value, instance, depth = 0, scheduled = false) => {
            if (depth > 16)
                throw new Error(M.nativeSandbox.nestingLimit);
            if (!value || typeof value !== "object")
                return value;
            if (Array.isArray(value))
                return value.map(item => decode(item, instance, depth + 1, scheduled));
            const object = row(value);
            if (object.$type === "NativePriority")
                return parseNativePriority(object);
            if (object.$type === "NativeFunction") {
                if (typeof object.id !== "string" || object.id.length > 128)
                    throw new Error(M.nativeSandbox.callbackHandle);
                return (...args) => invoke(instance, "callback", args, object.id, false, scheduled);
            }
            if (object.$type === "RegExp")
                throw new Error(M.nativeSandbox.regexpProcess);
            const result = Object.create(null);
            for (const [key, item] of Object.entries(object)) {
                if (["__proto__", "constructor", "prototype"].includes(key))
                    throw new Error(M.nativeSandbox.unsafeKey);
                result[key] = decode(item, instance, depth + 1, scheduled);
            }
            return result;
        };
        const assign = (instance) => {
            for (const key of Object.keys(metadata))
                if (!metadataKeys.has(key))
                    throw new Error(M.nativeSandbox.metadataUnsupported(key));
            for (const key of ["name", "dsc", "event", "namespace"])
                if (metadata[key] !== undefined &&
                    metadata[key] !== null &&
                    (typeof metadata[key] !== "string" || metadata[key].length > 2048))
                    throw new Error(M.nativeSandbox.fieldInvalid(key));
            parseNativePriority(metadata.priority);
            for (const [key, value] of Object.entries(metadata))
                if (key !== "rule" && key !== "namespace" && key !== "handler")
                    instance[key] = decode(value, instance, 0, key === "task");
            // 命名空间归属由可信加载器指定，不由插件指定。
            instance.namespace = namespace;
            if (instance.task) {
                const tasks = Array.isArray(instance.task) ? instance.task : [instance.task];
                for (const task of tasks)
                    if (typeof task.fnc === "string" && task.fnc) {
                        const method = task.fnc;
                        task.fnc = () => invoke(instance, method, [], undefined, false, true);
                    }
            }
            if (metadata.handler) {
                const handlers = Array.isArray(metadata.handler)
                    ? metadata.handler
                    : Object.values(row(metadata.handler));
                instance.handler = handlers.map((value) => {
                    const handler = row(value);
                    const name = `guardCallback_${randomUUID().replaceAll("-", "")}`;
                    instance[name] = (...args) => typeof handler.fn === "string"
                        ? invoke(instance, handler.fn, args, undefined, true)
                        : invoke(instance, "callback", args, row(handler.fn).id, true);
                    return {
                        ...handler,
                        fn: name,
                        ...(handler.priority === undefined
                            ? {}
                            : { priority: parseNativePriority(handler.priority) }),
                    };
                });
            }
            if (!Array.isArray(metadata.rule) || metadata.rule.length > 256)
                throw new Error(M.nativeSandbox.rules);
            instance.rule = metadata.rule.map((item, index) => {
                const rule = row(item);
                if (typeof rule.fnc !== "string" || !descriptor.methods.includes(rule.fnc))
                    throw new Error(M.nativeSandbox.ruleMethod);
                const copy = {};
                for (const [key, value] of Object.entries(rule)) {
                    if (!new Set(["reg", "fnc", "event", "log", "permission"]).has(key))
                        throw new Error(M.nativeSandbox.ruleMetadata(key));
                    if (key !== "reg")
                        copy[key] = decode(value, instance);
                }
                // 可信占位符不参与匹配，核心桥接等待 testRule。
                const regexp = new RegExp("(?:)");
                owner.ruleMarkers.set(regexp, { client, classId: descriptor.id, ruleIndex: index });
                owner.matchers.set(regexp, async (text) => {
                    const result = await client.request("native-match", {
                        classId: descriptor.id,
                        ruleIndex: index,
                        text,
                    });
                    if (typeof result !== "boolean")
                        throw new Error(M.nativeSandbox.matchResult);
                    return result;
                });
                copy.reg = regexp;
                return copy;
            });
        };
        class NativePluginProxy extends base {
            /** 创建代理插件实例。 */
            constructor() {
                super({});
                assign(this);
                // init 后只刷新两个加载器模板，不刷新消息实例。
                if (instances.size < 2)
                    instances.add(this);
            }
        }
        // 原生插件显示名不能作为宿主基类共享上下文存储的键。
        Object.defineProperty(NativePluginProxy.prototype, "conKey", {
            value() {
                return namespace;
            },
        });
        Object.defineProperty(NativePluginProxy.prototype, "getContext", {
            async value(_type, isGroup = false) {
                const values = row(await client.request("native-context", {
                    classId: descriptor.id,
                    isGroup,
                    event: snapshotEvent(this.e),
                }));
                const result = Object.create(null);
                if (Object.keys(values).length > 64)
                    throw new Error(M.nativeSandbox.contextMethods);
                for (const [method, value] of Object.entries(values)) {
                    const handle = row(value);
                    if (["getContext", "conKey"].includes(method) ||
                        (!descriptor.methods.includes(method) && method !== "resolveContext") ||
                        handle.$type !== "NativeContext" ||
                        typeof handle.id !== "string" ||
                        !/^ctx-[0-9a-f-]{36}$/.test(handle.id) ||
                        Object.keys(handle).some(key => !["$type", "id"].includes(key)))
                        throw new Error(M.nativeSandbox.contextHandle);
                    result[method] = Object.freeze({ $type: "NativeContext", id: handle.id });
                }
                return result;
            },
        });
        const installMethods = (methods) => {
            for (const method of new Set([...methods, "resolveContext"])) {
                if (Object.hasOwn(NativePluginProxy.prototype, method))
                    continue;
                Object.defineProperty(NativePluginProxy.prototype, method, {
                    configurable: false,
                    value(...args) {
                        return invoke(this, method, args);
                    },
                });
            }
        };
        installMethods(descriptor.methods);
        Object.defineProperty(NativePluginProxy, "name", {
            value: descriptor.name,
        });
        return NativePluginProxy;
    }
    /** 接入核心加载器，把沙箱插件交给核心加载。 */
    attach(loader) {
        this.loader = loader;
        const manager = this;
        if (detectCoreProfile(this.root).id === "jiuli" &&
            this.settings.pluginSandbox.native.plugins.some(item => item.enabled)) {
            if (typeof loader.deal !== "function")
                throw new Error(M.runtime.loaderExport);
            const originalDeal = loader.deal;
            loader.deal = function (...args) {
                const scope = new Map();
                return manager.messageScope.run(scope, async () => {
                    try {
                        return await Reflect.apply(originalDeal, this, args);
                    }
                    finally {
                        await manager.releaseInstances(scope);
                    }
                });
            };
        }
        const originalImport = loader.importPlugin;
        loader.importPlugin = async function (file, packageErrors) {
            if (!manager.configuration(file.name))
                return Reflect.apply(originalImport, this, [file, packageErrors]);
            const selected = manager.configuration(file.name);
            if (manager.loadedFiles.get(selected.id)?.has(file.name)) {
                if (/[?#]/.test(file.path)) {
                    const logger = Reflect.get(globalThis, "logger");
                    logger?.warn?.(M.nativeSandbox.restartToApply(file.name));
                    return false;
                }
                return true;
            }
            let client;
            this.pluginCountMap.set(file.name, 0);
            const start = performance.now();
            try {
                client = manager.client(file.name);
                if (/[?#]/.test(file.path))
                    throw new Error(M.nativeSandbox.sourceRestart);
                const entry = fs.realpathSync.native(path.resolve(manager.root, "lib/plugins", file.path));
                const relative = path.relative(client.pluginRoot, entry);
                if (!relative ||
                    relative.startsWith(`..${path.sep}`) ||
                    relative === ".." ||
                    path.isAbsolute(relative))
                    throw new Error(M.nativeSandbox.entryEscapes);
                const result = await client.load(entry);
                if (!result.classes.length)
                    throw new Error(M.nativeSandbox.noClasses(file.name));
                manager.registrations.reserve(client.config.id, file.name, result.classes);
                for (const descriptor of result.classes)
                    await this.loadPlugin(file, manager.constructorProxy(client, descriptor, file.name));
                const files = manager.loadedFiles.get(client.config.id) ?? new Set();
                files.add(file.name);
                manager.loadedFiles.set(client.config.id, files);
                return true;
            }
            catch (error) {
                const logger = Reflect.get(globalThis, "logger");
                logger?.error?.(M.nativeSandbox.loadError(file.name, String(error.message)));
                // 失败时拒绝加载，错误路径不得调用原导入器。
                const config = manager.configuration(file.name);
                manager.failedPlugins.add(config.id);
                const affected = new Set([file.name, ...(manager.loadedFiles.get(config.id) ?? [])]);
                for (const item of this.priority)
                    if (manager.configuration(item.key)?.id === config.id)
                        affected.add(item.key);
                let rollbackFailed = false;
                for (const key of affected) {
                    try {
                        await Reflect.apply(originalUnload, this, [key]);
                    }
                    catch (cleanupError) {
                        rollbackFailed = true;
                        logger?.error?.(M.nativeSandbox.removeFailed(key, cleanupError.message));
                    }
                }
                if (rollbackFailed) {
                    manager.loadedFiles.set(config.id, affected);
                    manager.emit({
                        kind: "plugin-sandbox",
                        plugin: config.id,
                        operation: "native.registration-cleanup-unconfirmed",
                        target: config.id,
                        action: "restart",
                    });
                }
                else {
                    manager.loadedFiles.delete(config.id);
                    manager.registrations.release(config.id);
                }
                await client?.close();
                manager.clients.delete(config.id);
                return false;
            }
            finally {
                this.load_time[file.name] = performance.now() - start;
            }
        };
        const originalUnload = loader.unloadPlugin;
        this.originalUnload = originalUnload;
        loader.unloadPlugin = async function (key, ...args) {
            let unloaded = false;
            try {
                const result = await Reflect.apply(originalUnload, this, [key, ...args]);
                unloaded = true;
                return result;
            }
            finally {
                const config = manager.configuration(key);
                if (config) {
                    if (!unloaded) {
                        manager.emit({
                            kind: "plugin-sandbox",
                            plugin: config.id,
                            operation: "native.registration-cleanup-unconfirmed",
                            target: config.id,
                            action: "restart",
                        });
                        await manager.clients.get(config.id)?.close();
                    }
                    else {
                        manager.registrations.release(config.id, key);
                        const files = manager.loadedFiles.get(config.id);
                        files?.delete(key);
                        if (!files?.size) {
                            await manager.clients.get(config.id)?.close();
                            manager.clients.delete(config.id);
                            manager.loadedFiles.delete(config.id);
                        }
                    }
                }
            }
        };
        const originalChange = loader.changePlugin;
        loader.changePlugin = function (key, ...args) {
            if (!manager.configuration(key))
                return Reflect.apply(originalChange, this, [key, ...args]);
            // 核心私有卸载路径绕过公开生命周期桥接，因此保留旧
            // 进程直至完整受控重启，不将修改后的源码重新加载到核心。
            const logger = Reflect.get(globalThis, "logger");
            logger?.warn?.(M.nativeSandbox.restartToApply(key));
            return false;
        };
    }
    /** 关闭全部沙箱会话。 */
    async close() {
        // 关闭插件进程前，先取消调度任务并注销 Handler。
        let unloadError;
        for (const files of [...this.loadedFiles.values()])
            for (const file of [...files])
                try {
                    await this.loader?.unloadPlugin(file);
                }
                catch (error) {
                    unloadError ??= error;
                }
        const results = await Promise.allSettled([...this.clients.values()].map(client => client.close()));
        this.clients.clear();
        const failure = results.find(result => result.status === "rejected");
        if (failure?.status === "rejected")
            throw failure.reason;
        if (unloadError)
            throw unloadError;
    }
}
//# sourceMappingURL=loader.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("native-sandbox/loader.ts", { NativePluginLoader })
