import { evaluatePolicy, GuardDeniedError } from "../config/policy.js";
import { LoaderHooks } from "./loader-hooks.js";
const apply = Reflect.apply;
const descriptor = Object.getOwnPropertyDescriptor;
const define = Object.defineProperty;
const names = Object.getOwnPropertyNames;
const limit = 128;
/** 饱和加一。 */
const increment = (value) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
/** 兼容性插桩只记录入口次数及归属，不构成恶意代码防护边界。 */
export class PluginMonitor {
    #context;
    #emit;
    #check;
    #watch;
    #currentPlugin;
    #observed = new WeakSet();
    #entries = new Map();
    #wrapped = new WeakMap();
    #instances = new WeakMap();
    #hooks;
    #truncated = false;
    /** 创建插件入口监控。 */
    constructor(context, emit, check, watch, currentPlugin) {
        this.#context = context;
        this.#emit = emit;
        this.#check = check;
        this.#watch = watch;
        this.#currentPlugin = currentPlugin;
    }
    /** 为插件实例登记反射入口观察。 */
    #observe(object, name, target) {
        if (!this.#watch || this.#observed.has(object))
            return;
        this.#observed.add(object);
        this.#watch.track(object, {
            after: change => {
                if (change.key === undefined && change.changed === false)
                    return;
                const plugin = this.#currentPlugin?.();
                const event = {
                    kind: "integrity",
                    operation: "plugin-function-hook",
                    target: `plugins/${encodeURIComponent(name)}#${target}`,
                    plugin: plugin ?? "unknown",
                    details: {
                        method: change.operation,
                        outcome: change.outcome,
                        changed: change.changed ?? "unknown",
                        blocked: change.outcome === "blocked",
                        detection: "during-call",
                        attribution: plugin ? "current-plugin" : "unknown",
                    },
                };
                this.#emit({ ...event, ...evaluatePolicy(this.#context.settings, event) });
            },
        });
    }
    /** 取得或创建插件活动统计条目。 */
    #entry(name) {
        const existing = this.#entries.get(name);
        if (existing)
            return existing;
        if (this.#entries.size >= limit) {
            this.#truncated = true;
            return undefined;
        }
        const row = {
            name: name.slice(0, 128),
            imports: 0,
            loads: 0,
            registered: 0,
            calls: 0,
            blocked: 0,
            unwrapped: 0,
        };
        this.#entries.set(name, row);
        return row;
    }
    /** 返回插件活动统计快照。 */
    snapshot() {
        return {
            entries: [...this.#entries.values()].map(row => ({ ...row })),
            truncated: this.#truncated,
        };
    }
    /** 让观察器比较受信插桩与其包装的原函数。 */
    originalFunction(value) {
        return this.#wrapped.get(value)?.original ?? value;
    }
    /** 登记核心创建的插件实例并包装其方法。 */
    attachInstance(instance, name) {
        this.#instances.set(instance, name);
        for (const key of names(instance))
            this.#wrap(instance, key, name);
        this.#observe(instance, name, "instance");
    }
    /** Yunzai 为每条消息新建处理器实例，须保留原 new.target。 */
    construct(constructor, args, name) {
        if (this.#hooks?.trusted(name))
            return Reflect.construct(constructor, args);
        return this.#invoke(name, "plugin.construct", constructor.name, () => {
            const instance = Reflect.construct(constructor, args);
            this.attachInstance(instance, name);
            return instance;
        });
    }
    /** 在插件上下文中执行入口，先按规则检查。 */
    #invoke(name, operation, target, callback) {
        const row = this.#entry(name);
        if (row) {
            const counter = operation === "plugin.import" ? "imports" : operation === "plugin.load" ? "loads" : "calls";
            row[counter] = increment(row[counter]);
        }
        const event = {
            kind: "plugin",
            plugin: name,
            operation,
            target,
            timestamp: new Date().toISOString(),
        };
        const decision = evaluatePolicy(this.#context.settings, event);
        if (decision.action !== "audit" && row)
            row.blocked = increment(row.blocked);
        this.#emit({ ...event, ...decision, details: { blocked: decision.action !== "audit" } });
        if (decision.action !== "audit")
            throw new GuardDeniedError(operation, decision.ruleId);
        this.#check();
        try {
            // 原样返回结果或 Promise；添加拒绝观察器会改变未处理拒绝的行为。
            return this.#context.run(name, callback);
        }
        finally {
            this.#check();
        }
    }
    /** 包装对象上的一个方法，保留原有 this 与返回值。 */
    #wrap(object, key, name, operation = "plugin.call") {
        const property = descriptor(object, key);
        if (typeof property?.value !== "function")
            return;
        const previous = this.#wrapped.get(property.value);
        if (previous?.name === name)
            return;
        const original = previous?.original ?? property.value;
        const monitor = this;
        const wrapped = function (...args) {
            const owner = this && (typeof this === "object" || typeof this === "function")
                ? (monitor.#instances.get(this) ?? name)
                : name;
            return monitor.#invoke(owner, operation, key, () => apply(original, this, args));
        };
        try {
            define(object, key, { ...property, value: wrapped });
            this.#wrapped.set(wrapped, { original, name });
            this.#observe(original, name, key);
            this.#observe(wrapped, name, key);
        }
        catch {
            const row = this.#entry(name);
            if (row)
                row.unwrapped = increment(row.unwrapped);
        }
    }
    /** 经钩子引擎桥接加载器实例，不修改构造器或磁盘核心源码；Guard 自有插件原样放行。 */
    attach(loader) {
        const monitor = this;
        const hooks = (this.#hooks = LoaderHooks.of(loader));
        hooks.around("importPlugin", (next, file, ...args) => hooks.trusted(file.name)
            ? next(file, ...args)
            : monitor.#invoke(file.name, "plugin.import", "module", () => next(file, ...args)));
        hooks.around("loadPlugin", (next, file, constructor) => {
            if (hooks.trusted(file.name))
                return next(file, constructor);
            const prototype = constructor?.prototype;
            if (prototype)
                for (const key of names(prototype))
                    if (key !== "constructor")
                        monitor.#wrap(prototype, key, file.name);
            if (prototype)
                monitor.#observe(prototype, file.name, "prototype");
            if (typeof constructor === "function")
                monitor.#observe(constructor, file.name, "constructor");
            return monitor.#invoke(file.name, "plugin.load", constructor?.name ?? "unknown", () => next(file, constructor));
        });
        hooks.around("registerHandlers", function (next, instance, ...args) {
            const entries = this.priority;
            const name = monitor.#instances.get(instance) ?? entries?.find(row => row.plugin === instance)?.key;
            if (name && !hooks.trusted(name)) {
                if (!monitor.#instances.has(instance)) {
                    const row = monitor.#entry(name);
                    if (row)
                        row.registered = increment(row.registered);
                }
                monitor.attachInstance(instance, name);
            }
            return next(instance, ...args);
        });
        hooks.around("collectTask", (next, task, name, key) => {
            if (!hooks.trusted(key))
                for (const item of Array.isArray(task) ? task : [task])
                    if (item && typeof item === "object") {
                        monitor.#wrap(item, "fnc", key, "plugin.task");
                        monitor.#observe(item, key, "task");
                    }
            return next(task, name, key);
        });
    }
}
//# sourceMappingURL=plugin.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("monitor/plugin.ts", { PluginMonitor })
