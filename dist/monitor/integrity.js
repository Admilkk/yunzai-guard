import { setInterval, clearInterval } from "node:timers";
import { evaluatePolicy } from "../config/policy.js";
import { objectDescriptor as getDescriptor, objectPrototype as getPrototype, reflectGet as get, arrayEach, arrayMap, arraySome, arrayIncludes, arrayPush, stringSplit, newMap, mapGet, mapSet, mapHas, mapDelete, mapClear, mapEach, newSet, setAdd, setHas, setDelete, timestamp, isReference, sameDescriptor, } from "../protect/intrinsics.js";
import { M } from "../shared/messages.js";
/** 读取一级属性，记录沿原型链找到的所有者。 */
function step(object, key) {
    const chain = [];
    let current = object;
    let descriptor;
    let owner;
    while (current) {
        if (chain.length >= 64 || arrayIncludes(chain, current))
            throw new Error(M.monitor.prototypeDepth);
        arrayPush(chain, current);
        if (!descriptor) {
            descriptor = getDescriptor(current, key);
            if (descriptor)
                owner = current;
        }
        current = getPrototype(current);
    }
    return { object, key, chain, descriptor, owner, value: get(object, key) };
}
/** 按点分路径读取目标及其属性链快照。 */
function read(roots, target) {
    const keys = stringSplit(target, ".");
    const root = roots[keys[0]];
    if (!isReference(root))
        return undefined;
    const steps = [];
    let value = root;
    for (let index = 1; index < keys.length; index++) {
        const key = keys[index];
        if (!isReference(value))
            return undefined;
        const result = step(value, key);
        arrayPush(steps, result);
        value = result.value;
    }
    if (value === undefined)
        return undefined;
    return { root, steps };
}
/** 比较两个快照，返回变化原因或 undefined。 */
function difference(before, after) {
    if (!after)
        return "unavailable";
    if (before.root !== after.root)
        return "root";
    if (before.steps.length !== after.steps.length)
        return "path";
    for (let i = 0; i < before.steps.length; i++) {
        const a = before.steps[i];
        const b = after.steps[i];
        if (a.object !== b.object)
            return "path";
        if (a.chain.length !== b.chain.length || arraySome(a.chain, (item, n) => item !== b.chain[n]))
            return "prototype";
        if (a.owner !== b.owner || !sameDescriptor(a.descriptor, b.descriptor))
            return "descriptor";
        if (a.value !== b.value)
            return "value";
    }
    return undefined;
}
/** 定期检查对象身份和描述符以检测篡改，不构成 VM 安全边界。 */
export class IntegrityMonitor {
    #settings;
    #roots;
    #emit;
    #watch;
    #subscriptions = newMap();
    #baseline = newMap();
    #reported = newSet();
    #unavailable = newMap();
    #timer;
    /** 创建关键函数完整性监控。 */
    constructor(settings, roots, emit, watch) {
        this.#settings = settings;
        this.#roots = roots;
        this.#emit = emit;
        this.#watch = watch;
    }
    /** 对目标所在对象登记反射入口观察，变化时立即检查。 */
    #observe(target, snapshot) {
        if (!this.#watch)
            return;
        arrayEach(mapGet(this.#subscriptions, target) ?? [], stop => stop());
        const stops = [];
        const seen = newMap();
        arrayEach(snapshot.steps, step => arrayEach(step.chain, object => {
            let keys = mapGet(seen, object);
            if (!keys)
                mapSet(seen, object, (keys = newSet()));
            if (setHas(keys, step.key))
                return;
            setAdd(keys, step.key);
            arrayPush(stops, this.#watch.track(object, {
                after: change => {
                    if (change.key === undefined && change.changed === false)
                        return;
                    if (change.changed)
                        setAdd(this.#reported, target);
                    const event = {
                        kind: "integrity",
                        operation: change.changed === true ? "protected-target-change" : "protected-target-hook",
                        target,
                        timestamp: timestamp(),
                        details: {
                            method: change.operation,
                            outcome: change.outcome,
                            changed: change.changed ?? "unknown",
                            blocked: change.outcome === "blocked",
                            detection: "during-call",
                        },
                    };
                    const decision = evaluatePolicy(this.#settings, event);
                    this.#emit({
                        ...event,
                        ...decision,
                        action: decision.ruleId || change.changed !== true
                            ? decision.action
                            : this.#settings.protect.action,
                    });
                },
            }, step.key));
        }));
        mapSet(this.#subscriptions, target, stops);
    }
    /** 每个目标只在首次出现时捕获一次，已有基线不再刷新。 */
    capture() {
        if (!this.#settings.protect.enabled)
            return;
        let roots;
        try {
            roots = typeof this.#roots === "function" ? this.#roots() : this.#roots;
        }
        catch {
            arrayEach(this.#settings.protect.targets, target => mapSet(this.#unavailable, target, "inspection-failed"));
            return;
        }
        arrayEach(this.#settings.protect.targets, target => {
            if (mapHas(this.#baseline, target))
                return;
            try {
                const snapshot = read(roots, target);
                if (snapshot) {
                    mapSet(this.#baseline, target, snapshot);
                    this.#observe(target, snapshot);
                    mapDelete(this.#unavailable, target);
                }
                else
                    mapSet(this.#unavailable, target, "missing");
            }
            catch {
                mapSet(this.#unavailable, target, "inspection-failed");
                // 目标可能稍后才创建；抛错的 getter 不能作为可信基线。
            }
        });
    }
    /** 覆盖率由运行时自报，不能独立证明可抵御同进程恶意代码。 */
    coverage() {
        return {
            enabled: this.#settings.protect.enabled,
            targets: arrayMap(this.#settings.protect.targets, (target) => ({
                target,
                state: !this.#settings.protect.enabled
                    ? "disabled"
                    : mapGet(this.#unavailable, target) === "inspection-failed"
                        ? "inspection-failed"
                        : setHas(this.#reported, target)
                            ? "changed"
                            : mapHas(this.#baseline, target)
                                ? "protected"
                                : "pending",
                ...(mapHas(this.#unavailable, target)
                    ? { reason: mapGet(this.#unavailable, target) }
                    : {}),
            })),
        };
    }
    /** 检查全部目标，变化时按配置上报一次。 */
    check() {
        if (!this.#settings.protect.enabled)
            return;
        let roots;
        try {
            roots = typeof this.#roots === "function" ? this.#roots() : this.#roots;
        }
        catch {
            roots = {};
        }
        mapEach(this.#baseline, (baseline, target) => {
            let reason;
            try {
                const current = read(roots, target);
                reason = difference(baseline, current);
                if (current)
                    this.#observe(target, current);
                mapDelete(this.#unavailable, target);
            }
            catch {
                reason = "inspection-failed";
                mapSet(this.#unavailable, target, "inspection-failed");
            }
            if (!reason) {
                setDelete(this.#reported, target);
                return;
            }
            if (setHas(this.#reported, target))
                return;
            setAdd(this.#reported, target);
            const event = {
                kind: "integrity",
                operation: "protected-target-change",
                target,
                timestamp: timestamp(),
                details: { reason, blocked: false, detection: "after-change" },
            };
            const decision = evaluatePolicy(this.#settings, event);
            this.#emit({
                ...event,
                ...decision,
                action: decision.ruleId ? decision.action : this.#settings.protect.action,
            });
        });
        this.capture();
    }
    /** 启动定期检查。 */
    start() {
        if (this.#timer || !this.#settings.protect.enabled)
            return;
        mapEach(this.#baseline, (baseline, target) => {
            if (!mapHas(this.#subscriptions, target))
                this.#observe(target, baseline);
        });
        this.capture();
        this.#timer = setInterval(() => this.check(), this.#settings.protect.intervalMs);
        this.#timer.unref();
    }
    /** 停止定期检查。 */
    stop() {
        if (this.#timer)
            clearInterval(this.#timer);
        this.#timer = undefined;
        mapEach(this.#subscriptions, stops => arrayEach(stops, stop => stop()));
        mapClear(this.#subscriptions);
    }
}
//# sourceMappingURL=integrity.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("monitor/integrity.ts", { IntegrityMonitor })
