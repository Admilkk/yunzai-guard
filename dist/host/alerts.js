import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
const kindLabels = {
    network: "网络访问",
    filesystem: "文件写入",
    process: "启动进程",
    native: "加载原生扩展",
    listen: "端口监听",
    plugin: "插件调用",
    "self-protection": "改动 Guard 自身文件",
};
const maxStateIds = 500;
const maxMutes = 50;
const maxPending = 20;
const maxHistoryBytes = 400 * 1024;
const keepHistoryLines = 300;
const batchSize = 100;
const batchDelayMs = 5000;
const maxQueued = 1000;
/** 生成告警编号：时间加随机后缀，保证同一毫秒内也不重复。 */
const newId = (time) => `${time.toString(36)}${randomBytes(3).toString("hex")}`;
/** 截断过长文本。 */
const clip = (value, length = 200) => String(value ?? "").slice(0, length);
/**
 * 告警出口：把拦截、熔断、完整性、异常与更新结果推给主人，并可转发到 Webhook。
 * 同类告警按窗口限流，超出的合并成一条摘要。
 */
export class AlertService {
    #options;
    #file;
    #stateFile;
    #state;
    #pending = [];
    #queued = [];
    #throttle = { windowStart: 0, sent: 0, suppressed: new Map() };
    #keys = new Map();
    #digest;
    #batch;
    /** 记录告警历史到状态目录。 */
    constructor(options) {
        this.#options = options;
        this.#file = path.join(options.stateDir, "alerts.jsonl");
        this.#stateFile = path.join(options.stateDir, "alert-state.json");
        this.#state = this.#loadState();
    }
    /** 已读标记与静默条件；顺带清掉已过期的静默。 */
    state() {
        const now = Date.now();
        if (this.#state.mutes.some(item => item.until <= now)) {
            this.#state = { ...this.#state, mutes: this.#state.mutes.filter(item => item.until > now) };
            this.#saveState();
        }
        return { ...this.#state, read: [...this.#state.read], mutes: [...this.#state.mutes] };
    }
    /** 标记已读：不带编号时全部标为已读。 */
    acknowledge(ids) {
        this.#state =
            ids === undefined
                ? { ...this.#state, readBefore: Date.now(), read: [] }
                : { ...this.#state, read: [...new Set([...this.#state.read, ...ids])].slice(-maxStateIds) };
        this.#saveState();
    }
    /** 静默某个插件或某类告警一段时间；同一条件重复设置只刷新到期时间。 */
    mute(target, minutes) {
        const key = target.plugin ? `plugin:${target.plugin}` : `category:${target.category}`;
        const item = {
            key,
            ...(target.plugin ? { plugin: target.plugin } : { category: target.category }),
            until: Date.now() + minutes * 60_000,
        };
        this.#state = {
            ...this.#state,
            mutes: [...this.#state.mutes.filter(old => old.key !== key), item].slice(-maxMutes),
        };
        this.#saveState();
        return item;
    }
    /** 取消静默。 */
    unmute(key) {
        this.#state = { ...this.#state, mutes: this.#state.mutes.filter(item => item.key !== key) };
        this.#saveState();
    }
    /** 当前是否被静默。 */
    #muted(category, plugin) {
        const now = Date.now();
        return this.#state.mutes.some(item => item.until > now &&
            ((item.plugin !== undefined && item.plugin === plugin) || item.category === category));
    }
    #loadState() {
        const empty = { readBefore: 0, read: [], mutes: [] };
        try {
            const value = JSON.parse(fs.readFileSync(this.#stateFile, "utf8"));
            return {
                readBefore: Number.isFinite(value.readBefore) ? Number(value.readBefore) : 0,
                read: Array.isArray(value.read)
                    ? value.read.filter((id) => typeof id === "string").slice(-maxStateIds)
                    : [],
                mutes: Array.isArray(value.mutes)
                    ? value.mutes
                        .filter(item => item &&
                        typeof item.key === "string" &&
                        Number.isFinite(item.until) &&
                        (typeof item.plugin === "string" || typeof item.category === "string"))
                        .slice(-maxMutes)
                    : [],
            };
        }
        catch {
            return empty;
        }
    }
    #saveState() {
        try {
            fs.mkdirSync(this.#options.stateDir, { recursive: true });
            fs.writeFileSync(this.#stateFile, JSON.stringify(this.#state), { mode: 0o600 });
        }
        catch {
            // 状态写入失败只影响重启后的已读与静默。
        }
    }
    /** 当前告警配置。 */
    get #config() {
        return this.#options.settings().alerts;
    }
    /** 登记一条告警：未启用的类别直接忽略，同类重复与超量的合并到摘要。 */
    raise(category, title, text, meta = {}) {
        const config = this.#config;
        if (!config.enabled || !config.on[category])
            return;
        const now = Date.now();
        const window = config.throttle.windowMs;
        if (now - this.#throttle.windowStart >= window) {
            this.#throttle = { windowStart: now, sent: 0, suppressed: this.#throttle.suppressed };
            for (const [key, time] of this.#keys)
                if (now - time >= window)
                    this.#keys.delete(key);
        }
        const key = meta.key ?? `${category}:${title}`;
        const duplicated = this.#keys.has(key);
        if (duplicated || this.#throttle.sent >= config.throttle.maxPerWindow) {
            this.#throttle.suppressed.set(key, (this.#throttle.suppressed.get(key) ?? 0) + 1);
            this.#digest ??= setTimeout(() => this.#flushDigest(), window);
            this.#digest.unref();
            return;
        }
        if (this.#muted(category, meta.plugin)) {
            this.#append({ id: newId(now), time: now, category, title, text, ...meta, muted: true });
            return;
        }
        this.#keys.set(key, now);
        this.#throttle.sent++;
        this.#deliver({ id: newId(now), time: now, category, title, text, ...meta });
    }
    /** 发出被合并的摘要。 */
    #flushDigest() {
        this.#digest = undefined;
        const entries = [...this.#throttle.suppressed.entries()].sort((a, b) => b[1] - a[1]);
        this.#throttle.suppressed = new Map();
        if (!entries.length)
            return;
        const total = entries.reduce((sum, item) => sum + item[1], 0);
        const minutes = Math.max(1, Math.round(this.#config.throttle.windowMs / 60000));
        const top = entries
            .slice(0, 3)
            .map(([key, count]) => `${key.split(":").slice(1).join(":")} ×${count}`)
            .join("；");
        this.#deliver({
            id: newId(Date.now()),
            time: Date.now(),
            category: "digest",
            title: "告警合并",
            text: `【Yunzai Guard】过去 ${minutes} 分钟内另有 ${total} 条告警被合并：${top}`,
        });
    }
    /** 写入历史，并送达主人与 Webhook。 */
    #deliver(record) {
        this.#append(record);
        this.#options.record("alert", { category: record.category, title: record.title });
        const config = this.#config;
        if (config.masters && !this.#options.send(record.text)) {
            this.#pending.push(record.text);
            if (this.#pending.length > maxPending)
                this.#pending.shift();
        }
        if (config.webhook.url)
            void this.#post(record);
    }
    /** 把审计事件转为告警，并按转发设置加入 Webhook 队列。 */
    onEvent(event) {
        const config = this.#config;
        const action = String(event.action ?? "");
        const plugin = clip(event.plugin, 80) || "unknown";
        const kind = String(event.kind ?? "");
        const target = clip(event.target);
        if (config.webhook.url && config.forward.actions.includes(action)) {
            if (!config.forward.kinds.length || config.forward.kinds.includes(kind))
                this.#enqueue(event);
        }
        if (action !== "deny" && action !== "restart")
            return;
        const label = kindLabels[kind] ?? kind;
        const rule = clip(event.ruleId, 80) || (kind === "self-protection" ? "自保护" : "默认策略");
        const text = action === "deny"
            ? `【Yunzai Guard】已拦截 ${plugin}：${label} ${target}（规则 ${rule}）`
            : `【Yunzai Guard】${plugin} 触发了重启规则 ${rule}（${label} ${target}），业务进程将重建`;
        this.raise(action, `${plugin} ${label}`, text, {
            key: `${action}:${plugin}:${clip(event.operation, 60)}:${rule}`,
            plugin,
        });
    }
    /** 补发业务进程不在线时留存的主人通知。 */
    flush() {
        while (this.#pending.length && this.#options.send(this.#pending[0]))
            this.#pending.shift();
    }
    /** 最近的告警历史，新的在前；跳过损坏或缺少展示字段的记录。 */
    history(limit = 100) {
        try {
            return fs
                .readFileSync(this.#file, "utf8")
                .split("\n")
                .filter(Boolean)
                .slice(-limit)
                .flatMap(line => {
                try {
                    const value = JSON.parse(line);
                    if (!value ||
                        typeof value !== "object" ||
                        Array.isArray(value) ||
                        typeof value.time !== "number" ||
                        !Number.isFinite(value.time) ||
                        typeof value.category !== "string" ||
                        typeof value.title !== "string" ||
                        typeof value.text !== "string" ||
                        (value.plugin !== undefined && typeof value.plugin !== "string") ||
                        (value.severity !== undefined && typeof value.severity !== "string") ||
                        (value.id !== undefined && typeof value.id !== "string"))
                        return [];
                    return [{ ...value, id: value.id ?? `t${value.time}` }];
                }
                catch {
                    return [];
                }
            })
                .reverse();
        }
        catch {
            return [];
        }
    }
    /** 向 Webhook 发送一条测试消息。 */
    async testWebhook() {
        const url = this.#config.webhook.url;
        if (!url)
            return { ok: false, error: "未配置 Webhook 地址" };
        try {
            const status = await this.#send(url, {
                type: "yunzai-guard.test",
                text: "【Yunzai Guard】这是一条测试消息",
            });
            return { ok: status >= 200 && status < 300, status };
        }
        catch (error) {
            return { ok: false, error: error.message };
        }
    }
    /** 停止定时器，尽量发出剩余的转发队列。 */
    stop() {
        clearTimeout(this.#digest);
        clearTimeout(this.#batch);
        this.#digest = this.#batch = undefined;
        void this.#sendBatch();
    }
    /** 加入转发队列，并在短延迟后成批发送。 */
    #enqueue(event) {
        this.#queued.push({
            time: event.timestamp ?? new Date().toISOString(),
            plugin: event.plugin,
            kind: event.kind,
            operation: event.operation,
            target: clip(event.target),
            action: event.action,
            ruleId: event.ruleId,
        });
        if (this.#queued.length > maxQueued)
            this.#queued.shift();
        this.#batch ??= setTimeout(() => void this.#sendBatch(), batchDelayMs);
        this.#batch.unref();
    }
    /** 发送一批转发事件，失败时记录后丢弃，避免无限堆积。 */
    async #sendBatch() {
        this.#batch = undefined;
        const url = this.#config.webhook.url;
        const events = this.#queued.splice(0, batchSize);
        if (!url || !events.length)
            return;
        if (this.#queued.length) {
            this.#batch = setTimeout(() => void this.#sendBatch(), batchDelayMs);
            this.#batch.unref();
        }
        try {
            await this.#send(url, { type: "yunzai-guard.events", events });
        }
        catch (error) {
            this.#options.record("webhook-failed", { message: error.message });
        }
    }
    /** 发送一条告警到 Webhook。 */
    async #post(record) {
        try {
            await this.#send(this.#config.webhook.url, {
                type: "yunzai-guard.alert",
                category: record.category,
                title: record.title,
                text: record.text,
                time: record.time,
                plugin: record.plugin,
                severity: record.severity,
            });
        }
        catch (error) {
            this.#options.record("webhook-failed", { message: error.message });
        }
    }
    /** 按配置格式发送；有密钥时附 HMAC-SHA256 签名。 */
    async #send(url, payload) {
        const { secret, format } = this.#config.webhook;
        const instance = { id: this.#options.projectId, host: os.hostname() };
        const lines = payload.type === "yunzai-guard.events"
            ? payload.events
                .map(item => `${item.action} ${item.plugin} ${item.kind} ${item.target}`)
                .join("\n")
            : String(payload.text ?? "");
        const body = format === "text"
            ? lines
            : JSON.stringify({ ...payload, instance, text: payload.text ?? lines });
        const headers = {
            "Content-Type": format === "text" ? "text/plain; charset=utf-8" : "application/json",
            "User-Agent": "yunzai-guard",
        };
        if (secret)
            headers["X-Guard-Signature"] =
                `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
        const response = await fetch(url, {
            method: "POST",
            headers,
            body,
            redirect: "manual",
            signal: AbortSignal.timeout(5000),
        });
        return response.status;
    }
    /** 追加历史行；文件过大时只保留尾部。 */
    #append(record) {
        try {
            fs.mkdirSync(this.#options.stateDir, { recursive: true });
            fs.appendFileSync(this.#file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
            if (fs.statSync(this.#file).size > maxHistoryBytes) {
                const lines = fs.readFileSync(this.#file, "utf8").split("\n").filter(Boolean);
                fs.writeFileSync(this.#file, `${lines.slice(-keepHistoryLines).join("\n")}\n`, {
                    mode: 0o600,
                });
            }
        }
        catch {
            // 历史写入失败不影响告警送达。
        }
    }
}
//# sourceMappingURL=alerts.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("host/alerts.ts", { AlertService })
