import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { matchGlob } from "../config/policy.js";
const rank = { low: 0, medium: 1, high: 2 };
const hour = 3600000;
const alpha = 0.2;
const maxAnomalies = 50;
const maxDays = 60;
const shells = new Set([
    "cmd",
    "powershell",
    "pwsh",
    "bash",
    "sh",
    "zsh",
    "curl",
    "wget",
    "nc",
    "ncat",
]);
const sensitivePath = /(^|\/)(\.ssh|\.aws|\.gnupg|etc|windows|system32|startup)(\/|$)/i;
/** 判断严重度是否不低于下限。 */
export function atLeast(value, minimum) {
    return rank[value] >= rank[minimum];
}
/** 取目标的最后一段名称并去掉 .exe 后缀。 */
function baseName(target) {
    const clean = target.trim().replace(/^["']|["']$/g, "");
    const name = clean.split(/[\\/]/).filter(Boolean).at(-1) ?? clean;
    return name.replace(/\.exe$/i, "").toLowerCase();
}
/** 把事件归并为“类型 + 对象”形式的行为特征；不关心的类型返回 undefined。 */
export function featureOf(event) {
    const target = event.target;
    switch (event.kind) {
        case "network": {
            try {
                const host = new URL(target).hostname.toLowerCase();
                if (host)
                    return { kind: "network", key: host };
            }
            catch {
                // 非 URL 目标按原文归并。
            }
            return target ? { kind: "network", key: target.slice(0, 200).toLowerCase() } : undefined;
        }
        case "listen": {
            const port = /:(\d+)\/?$/.exec(target)?.[1];
            return port ? { kind: "listen", key: `端口 ${port}` } : undefined;
        }
        case "process":
            return target ? { kind: "process", key: baseName(target) } : undefined;
        case "native":
            return target ? { kind: "native", key: baseName(target) } : undefined;
        case "filesystem": {
            const normalized = target.replace(/\\/g, "/");
            const directory = normalized.slice(0, Math.max(0, normalized.lastIndexOf("/"))) || normalized;
            return { kind: "filesystem", key: directory.slice(0, 240) };
        }
        default:
            return undefined;
    }
}
/** 估计一个新行为的严重程度：能执行代码或对外开放的更高，普通文件目录更低。 */
export function severityOf(kind, key) {
    if (kind === "native" || kind === "listen")
        return "high";
    if (kind === "process")
        return shells.has(key) ? "high" : "medium";
    if (kind === "network")
        return /^\d{1,3}(\.\d{1,3}){3}$|^\[?[0-9a-f:]+\]?$/i.test(key) ? "high" : "medium";
    return sensitivePath.test(key) ? "high" : "low";
}
/** 行为画像：学习每个插件的常规行为，并在之后识别新目标、频率突增、非常规时段与批量探测。 */
export class BehaviorProfile {
    #file;
    #settings;
    #clock;
    #plugins = {};
    #timer;
    #dirty = false;
    /** 读取已保存的画像；文件缺失或损坏时从空画像开始。 */
    constructor(options) {
        this.#file = options.file;
        this.#settings = options.settings;
        this.#clock = options.clock ?? Date.now;
        try {
            const value = JSON.parse(fs.readFileSync(this.#file, "utf8"));
            if (value.plugins && typeof value.plugins === "object")
                this.#plugins = value.plugins;
        }
        catch {
            // 首次运行或文件损坏。
        }
    }
    /** 是否仍在学习期。 */
    #learning(profile, now) {
        if (profile.endedAt !== undefined)
            return false;
        return now < profile.startedAt + this.#settings().learnHours * hour;
    }
    /** 登记一个异常并返回它。 */
    #raise(profile, plugin, now, type, severity, kind, key, detail) {
        const anomaly = {
            id: randomBytes(6).toString("hex"),
            time: now,
            plugin,
            type,
            severity,
            kind,
            key,
            detail,
        };
        profile.anomalies = [...profile.anomalies, anomaly].slice(-maxAnomalies);
        return anomaly;
    }
    /** 结算已过去的统计窗口：更新该类型的均值与方差，并检查频率突增。 */
    #roll(profile, plugin, kind, now, found) {
        const config = this.#settings().spike;
        const rate = (profile.rates[kind] ??= {
            mean: 0,
            variance: 0,
            windows: 0,
            current: 0,
            windowStart: now,
        });
        let guard = 0;
        while (now >= rate.windowStart + config.windowMs && guard++ < 50) {
            const count = rate.current;
            if (config.enabled &&
                rate.windows >= 6 &&
                count >= config.minCount &&
                !this.#learning(profile, now)) {
                const deviation = Math.sqrt(rate.variance);
                if (count > rate.mean + config.zScore * Math.max(deviation, 1)) {
                    const ratio = count / Math.max(rate.mean, 1);
                    found.push(this.#raise(profile, plugin, now, "rate-spike", ratio >= 10 ? "high" : "medium", kind, "频率", `${Math.round(config.windowMs / 60000)} 分钟内 ${count} 次，平时约 ${rate.mean.toFixed(1)} 次`));
                }
            }
            const delta = count - rate.mean;
            rate.mean += alpha * delta;
            rate.variance = (1 - alpha) * (rate.variance + alpha * delta * delta);
            rate.windows++;
            rate.current = 0;
            rate.windowStart += config.windowMs;
        }
        if (now >= rate.windowStart + config.windowMs)
            rate.windowStart = now;
    }
    /** 处理一条行为事件，返回由它触发的异常。 */
    observe(event) {
        const config = this.#settings();
        const plugin = event.plugin;
        if (!config.enabled || !plugin || plugin === "unknown")
            return [];
        if (config.ignorePlugins.some(pattern => matchGlob(pattern, plugin)))
            return [];
        const feature = featureOf(event);
        if (!feature || !config.kinds.includes(feature.kind))
            return [];
        const label = `${feature.kind}:${feature.key}`;
        if (config.ignore.some(pattern => matchGlob(pattern, label) || matchGlob(pattern, event.target)))
            return [];
        const now = event.time ?? this.#clock();
        const profile = (this.#plugins[plugin] ??= {
            startedAt: now,
            total: 0,
            features: {},
            hourly: new Array(24).fill(0),
            learnedHourly: new Array(24).fill(0),
            learnedTotal: 0,
            days: [],
            rates: {},
            newTargets: [],
            anomalies: [],
            cooldown: {},
        });
        const found = [];
        const learning = this.#learning(profile, now);
        const date = new Date(now);
        const slot = date.getHours();
        const day = date.toISOString().slice(0, 10);
        this.#roll(profile, plugin, feature.kind, now, found);
        profile.rates[feature.kind].current++;
        profile.total++;
        profile.hourly[slot]++;
        if (!profile.days.includes(day))
            profile.days = [...profile.days, day].slice(-maxDays);
        if (learning) {
            profile.learnedHourly[slot]++;
            profile.learnedTotal++;
        }
        const id = `${feature.kind}|${feature.key}`;
        const known = profile.features[id];
        if (known) {
            known.count++;
            known.lastAt = now;
        }
        else {
            const add = learning || config.learnAfterAlert;
            if (add) {
                const keys = Object.keys(profile.features);
                if (keys.length >= config.maxPerPlugin) {
                    const oldest = keys.sort((a, b) => profile.features[a].lastAt - profile.features[b].lastAt)[0];
                    delete profile.features[oldest];
                }
                profile.features[id] = { count: 1, firstAt: now, lastAt: now };
            }
            if (!learning) {
                found.push(this.#raise(profile, plugin, now, "new-target", severityOf(feature.kind, feature.key), feature.kind, feature.key, `学习期之后首次出现：${event.operation ?? feature.kind} ${event.target}`.slice(0, 300)));
                profile.newTargets = [...profile.newTargets, now].filter(time => now - time <= config.burst.windowMs);
                if (config.burst.enabled &&
                    profile.newTargets.length >= config.burst.count &&
                    now - (profile.cooldown.burst ?? 0) > config.burst.windowMs) {
                    profile.cooldown.burst = now;
                    found.push(this.#raise(profile, plugin, now, "burst", "high", feature.kind, "批量新目标", `${Math.round(config.burst.windowMs / 60000)} 分钟内出现 ${profile.newTargets.length} 个新目标，可能是扫描或数据外送`));
                }
            }
        }
        if (!learning &&
            config.offHours &&
            profile.learnedTotal >= 50 &&
            profile.days.length >= 2 &&
            [slot + 23, slot, slot + 1].every(item => profile.learnedHourly[item % 24] === 0)) {
            const marker = date.getDate() * 100 + slot;
            if (profile.cooldown.offHours !== marker) {
                profile.cooldown.offHours = marker;
                found.push(this.#raise(profile, plugin, now, "off-hours", "low", feature.kind, `${slot} 点`, `学习期内该插件从未在 ${slot} 点前后活动，现在出现 ${feature.kind} 行为`));
            }
        }
        this.#changed();
        return found;
    }
    /** 定时结算统计窗口，检查没有新事件时也会发生的频率突增。 */
    tick(now = this.#clock()) {
        const found = [];
        for (const [plugin, profile] of Object.entries(this.#plugins))
            for (const kind of Object.keys(profile.rates))
                this.#roll(profile, plugin, kind, now, found);
        if (found.length)
            this.#changed();
        return found;
    }
    /** 风险分：能力面越广、近期异常越多越高。 */
    #risk(profile, now) {
        const kinds = {};
        for (const id of Object.keys(profile.features)) {
            const kind = id.slice(0, id.indexOf("|"));
            kinds[kind] = (kinds[kind] ?? 0) + 1;
        }
        let score = 0;
        if (kinds.native)
            score += 25;
        if (kinds.process)
            score += Math.min(25, 10 + kinds.process * 3);
        if (kinds.listen)
            score += 15;
        score += Math.min(20, (kinds.network ?? 0) * 2);
        score += Math.min(10, kinds.filesystem ?? 0);
        for (const item of profile.anomalies)
            if (now - item.time <= 7 * 24 * hour)
                score += item.severity === "high" ? 10 : item.severity === "medium" ? 5 : 1;
        score = Math.min(100, score);
        return { score, level: score >= 60 ? "high" : score >= 30 ? "medium" : "low" };
    }
    /** 各插件的画像摘要。 */
    summary(now = this.#clock()) {
        const config = this.#settings();
        return {
            enabled: config.enabled,
            learnHours: config.learnHours,
            plugins: Object.entries(this.#plugins)
                .map(([plugin, profile]) => {
                const kinds = {};
                for (const id of Object.keys(profile.features)) {
                    const kind = id.slice(0, id.indexOf("|"));
                    kinds[kind] = (kinds[kind] ?? 0) + 1;
                }
                return {
                    plugin,
                    startedAt: profile.startedAt,
                    learning: this.#learning(profile, now),
                    learnEndsAt: profile.endedAt ?? profile.startedAt + config.learnHours * hour,
                    features: Object.keys(profile.features).length,
                    total: profile.total,
                    kinds,
                    risk: this.#risk(profile, now),
                    anomalies7d: profile.anomalies.filter(item => now - item.time <= 7 * 24 * hour).length,
                    lastAnomaly: profile.anomalies.at(-1),
                };
            })
                .sort((a, b) => b.risk.score - a.risk.score),
        };
    }
    /** 单个插件的完整画像。 */
    detail(plugin, now = this.#clock()) {
        const profile = this.#plugins[plugin];
        if (!profile)
            return undefined;
        return {
            plugin,
            startedAt: profile.startedAt,
            learning: this.#learning(profile, now),
            risk: this.#risk(profile, now),
            total: profile.total,
            days: profile.days.length,
            hourly: profile.hourly,
            features: Object.entries(profile.features)
                .map(([id, value]) => ({
                kind: id.slice(0, id.indexOf("|")),
                key: id.slice(id.indexOf("|") + 1),
                ...value,
            }))
                .sort((a, b) => b.count - a.count),
            anomalies: [...profile.anomalies].reverse(),
        };
    }
    /** 把一个行为加入常规画像（信任）。 */
    trust(plugin, kind, key) {
        const profile = this.#plugins[plugin];
        if (!profile)
            return false;
        const now = this.#clock();
        profile.features[`${kind}|${key}`] ??= { count: 0, firstAt: now, lastAt: now };
        this.#changed();
        return true;
    }
    /** 从画像中移除一个行为，之后再次出现会重新提示。 */
    forget(plugin, kind, key) {
        const profile = this.#plugins[plugin];
        if (!profile || !profile.features[`${kind}|${key}`])
            return false;
        delete profile.features[`${kind}|${key}`];
        this.#changed();
        return true;
    }
    /** 立即结束学习期，之后的新行为开始提示。 */
    endLearning(plugin) {
        let count = 0;
        for (const [name, profile] of Object.entries(this.#plugins))
            if ((!plugin || name === plugin) && profile.endedAt === undefined) {
                profile.endedAt = this.#clock();
                count++;
            }
        if (count)
            this.#changed();
        return count;
    }
    /** 清空画像并重新学习；不传插件名时清空全部。 */
    reset(plugin) {
        if (plugin)
            delete this.#plugins[plugin];
        else
            this.#plugins = {};
        this.#changed();
    }
    /** 标记有改动，稍后写盘。 */
    #changed() {
        this.#dirty = true;
        this.#timer ??= setTimeout(() => this.flush(), 5000);
        this.#timer.unref();
    }
    /** 立即写盘。 */
    flush() {
        clearTimeout(this.#timer);
        this.#timer = undefined;
        if (!this.#dirty)
            return;
        this.#dirty = false;
        try {
            fs.mkdirSync(path.dirname(this.#file), { recursive: true });
            const temporary = `${this.#file}.${randomBytes(4).toString("hex")}.tmp`;
            fs.writeFileSync(temporary, JSON.stringify({ version: 1, plugins: this.#plugins }), {
                mode: 0o600,
            });
            fs.renameSync(temporary, this.#file);
        }
        catch {
            // 写盘失败只影响重启后的画像延续。
        }
    }
}
//# sourceMappingURL=profile.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("host/profile.ts", { atLeast, featureOf, severityOf, BehaviorProfile })
