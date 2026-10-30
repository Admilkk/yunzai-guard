import path from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { randomCode } from "./panel-settings.js";
import { M } from "../shared/messages.js";
import { readJsonFile, writeJsonFile } from "../shared/files.js";
import { sha256 } from "../shared/hash.js";
export class PanelError extends Error {
    status;
    retryAfter;
    /** 创建带 HTTP 状态码的面板错误。 */
    constructor(status, message, retryAfter) {
        super(message);
        this.status = status;
        this.retryAfter = retryAfter;
        this.name = "PanelError";
    }
}
const maxFailures = 8;
const failureWindowMs = 5 * 60_000;
const blockMs = 5 * 60_000;
const codeTtlSeconds = 300;
const linkTtlSeconds = 300;
const linkCooldownMs = 30_000;
const linkPattern = /^[A-Za-z0-9_-]{43}$/;
const maxSessions = 32;
const maxAttempts = 1024;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
/** 以恒定时间比较两个秘密。 */
function sameSecret(a, b) {
    return timingSafeEqual(Buffer.from(sha256(a), "hex"), Buffer.from(sha256(b), "hex"));
}
/** 取字符串并截断，非字符串返回空串。 */
const text = (value, length) => typeof value === "string" ? value.slice(0, length) : "";
/** 校验会话记录的结构；落盘的只能是信任设备会话，热替换交接的只能是内存会话。 */
function validSession(value, remembered = true) {
    if (!value || typeof value !== "object")
        return false;
    const item = value;
    return (typeof item.id === "string" &&
        /^[A-Za-z0-9_-]{16}$/.test(item.id) &&
        [item.createdAt, item.lastSeenAt, item.expiresAt].every(Number.isSafeInteger) &&
        item.createdAt > 0 &&
        item.createdAt <= item.lastSeenAt &&
        item.lastSeenAt <= item.expiresAt &&
        item.remember === remembered &&
        typeof item.address === "string" &&
        item.address.length <= 128 &&
        typeof item.userAgent === "string" &&
        item.userAgent.length <= 256);
}
export class PanelAuth {
    #settings;
    #sessions = new Map();
    #attempts = new Map();
    #file;
    #secretId;
    #events;
    #code;
    #link;
    /** 创建会话管理器，可选持久化到状态目录。 */
    constructor(settings, stateDir, events = {}) {
        this.#settings = settings;
        this.#events = events;
        this.#secretId = sha256(settings().jwtSecret);
        this.#file = stateDir ? path.join(stateDir, "auth-sessions.json") : undefined;
        this.#load();
    }
    /** 当前有效会话数。 */
    get tokenCount() {
        this.#sweep();
        return this.#sessions.size;
    }
    /** 签发新会话令牌。 */
    issue(options = {}) {
        this.#sweep();
        const settings = this.#settings();
        const now = Date.now();
        const remember = options.remember === true;
        const duration = remember
            ? settings.trustedDeviceTtlDays * 24 * 3600_000
            : settings.tokenTtlHours * 3600_000;
        const token = randomBytes(32).toString("base64url");
        const record = {
            id: randomBytes(12).toString("base64url"),
            createdAt: now,
            lastSeenAt: now,
            expiresAt: now + duration,
            remember,
            address: text(options.address, 128),
            userAgent: text(options.userAgent, 256),
        };
        while (this.#sessions.size >= maxSessions) {
            const oldest = this.#sessions.keys().next().value;
            if (oldest === undefined)
                break;
            this.#sessions.delete(oldest);
        }
        this.#sessions.set(sha256(token), record);
        this.#persist();
        return token;
    }
    /** 校验会话令牌并刷新最近使用时间。 */
    verify(token) {
        const record = this.#get(token);
        if (!record)
            return undefined;
        record.lastSeenAt = Math.min(Date.now(), record.expiresAt);
        return {
            sub: "master",
            jti: record.id,
            iat: Math.floor(record.createdAt / 1000),
            exp: Math.floor(record.expiresAt / 1000),
            remember: record.remember,
        };
    }
    /** 返回会话对应的 CSRF 令牌。 */
    csrf(token) {
        if (!this.#get(token))
            throw new PanelError(401, M.web.sessionExpired);
        return createHmac("sha256", this.#settings().jwtSecret)
            .update(`panel-csrf-v1:${token}`)
            .digest("base64url");
    }
    /** 校验 CSRF 令牌。 */
    verifyCsrf(token, value) {
        return (Boolean(this.#get(token)) &&
            typeof value === "string" &&
            value.length === 43 &&
            sameSecret(this.csrf(token), value));
    }
    /** 列出有效会话，标记当前会话。 */
    sessions(currentToken) {
        this.#sweep();
        const current = typeof currentToken === "string" ? sha256(currentToken) : undefined;
        return [...this.#sessions]
            .map(([hash, item]) => ({ ...item, current: hash === current }))
            .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    }
    /** 撤销指定会话。 */
    revoke(id) {
        if (typeof id !== "string" || id.length !== 16)
            return false;
        for (const [hash, record] of this.#sessions) {
            if (record.id !== id)
                continue;
            this.#sessions.delete(hash);
            this.#persist();
            return true;
        }
        return false;
    }
    /** 注销当前会话。 */
    logout(token) {
        if (typeof token === "string" && this.#sessions.delete(sha256(token)))
            this.#persist();
    }
    /**
     * 导出仅保存在内存中的会话（未勾选信任设备），只含令牌摘要。
     * 热替换控制台时交给新控制台，避免更新后需要重新登录；这类会话仍不落盘。
     */
    exportVolatile() {
        const now = Date.now();
        return [...this.#sessions]
            .filter(([, session]) => !session.remember && session.expiresAt > now)
            .map(([hash, session]) => ({ hash, session: { ...session } }));
    }
    /** 接收上一个控制台交来的内存会话，格式不符的条目直接忽略。 */
    importVolatile(entries) {
        if (!Array.isArray(entries))
            return;
        const now = Date.now();
        for (const entry of entries.slice(0, maxSessions)) {
            const hash = entry?.hash;
            const session = entry?.session;
            if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) || !validSession(session, false))
                continue;
            if (session.expiresAt <= now || this.#sessions.size >= maxSessions)
                continue;
            this.#sessions.set(hash, session);
        }
    }
    /** 生成一次性登录验证码，已有有效验证码时拒绝。 */
    requestCode() {
        if (this.#code && this.#code.expires > Date.now())
            throw new PanelError(429, M.web.codeActive);
        const value = randomCode(16);
        this.#code = { hash: sha256(value), expires: Date.now() + codeTtlSeconds * 1000 };
        return value;
    }
    /**
     * 生成一次性登录链接令牌：5 分钟有效、仅能使用一次；新链接会使旧链接失效，
     * 冷却期内重复请求直接拒绝，避免被反复触发刷屏。
     */
    issueLink() {
        const now = Date.now();
        if (this.#link && now - this.#link.issuedAt < linkCooldownMs)
            throw new PanelError(429, M.web.linkCooldown);
        const token = randomBytes(32).toString("base64url");
        this.#link = { hash: sha256(token), issuedAt: now, expires: now + linkTtlSeconds * 1000 };
        return { token, ttlSeconds: linkTtlSeconds };
    }
    /** 校验登录链接令牌并签发会话；成功后立即作废。 */
    checkLink(input, address, options = {}) {
        this.#ensureAllowed(address);
        const token = typeof input === "string" && linkPattern.test(input) ? input : "";
        const link = this.#link;
        if (!token || !link || link.expires <= Date.now() || !sameSecret(link.hash, sha256(token))) {
            this.#fail(address);
            throw new PanelError(401, M.web.linkInvalid);
        }
        this.#link = undefined;
        this.#attempts.delete(address);
        return this.issue({ ...options, address });
    }
    /** 校验登录验证码并签发会话，失败次数超限时暂时封禁来源。 */
    checkCode(input, address, options = {}) {
        this.#ensureAllowed(address);
        const code = typeof input === "string" && input.length <= 32 ? input.trim().toUpperCase() : "";
        if (!code)
            throw new PanelError(400, M.web.codeRequired);
        if (!this.#code || this.#code.expires <= Date.now()) {
            this.#fail(address);
            throw new PanelError(401, M.web.codeExpired);
        }
        if (!sameSecret(this.#code.hash, sha256(code))) {
            this.#fail(address);
            throw new PanelError(401, M.web.codeWrong);
        }
        const token = this.issue({ ...options, address });
        this.#code = undefined;
        this.#attempts.delete(address);
        return token;
    }
    /** 按令牌取得有效会话。 */
    #get(token) {
        if (typeof token !== "string" || !tokenPattern.test(token))
            return undefined;
        const record = this.#sessions.get(sha256(token));
        if (!record)
            return undefined;
        if (record.expiresAt <= Date.now()) {
            this.#sessions.delete(sha256(token));
            this.#persist();
            return undefined;
        }
        return record;
    }
    /** 清理过期会话与失败记录。 */
    #sweep() {
        const now = Date.now();
        let changed = false;
        for (const [hash, record] of this.#sessions)
            if (record.expiresAt <= now) {
                this.#sessions.delete(hash);
                changed = true;
            }
        for (const [address, attempt] of this.#attempts)
            if (attempt.resetAt <= now && attempt.blockedUntil <= now)
                this.#attempts.delete(address);
        if (changed)
            this.#persist();
    }
    /** 检查来源地址是否因多次失败被暂时封禁。 */
    #ensureAllowed(address) {
        this.#sweep();
        const attempt = this.#attempts.get(address);
        if (attempt && attempt.blockedUntil > Date.now()) {
            const seconds = Math.ceil((attempt.blockedUntil - Date.now()) / 1000);
            throw new PanelError(429, M.web.tooManyAttempts(seconds), seconds);
        }
        // 表满时淘汰最早的记录而非拒绝所有新地址，避免攻击者占满表后锁住管理员。
        if (!attempt && this.#attempts.size >= maxAttempts) {
            const oldest = this.#attempts.keys().next().value;
            if (oldest !== undefined)
                this.#attempts.delete(oldest);
        }
    }
    /** 记录一次登录失败。 */
    #fail(address) {
        const now = Date.now();
        const attempt = this.#attempts.get(address) ?? {
            failures: 0,
            resetAt: now + failureWindowMs,
            blockedUntil: 0,
        };
        if (attempt.resetAt <= now) {
            attempt.failures = 0;
            attempt.resetAt = now + failureWindowMs;
        }
        const blocked = ++attempt.failures >= maxFailures;
        if (blocked) {
            attempt.failures = 0;
            attempt.blockedUntil = now + blockMs;
        }
        this.#attempts.set(address, attempt);
        try {
            this.#events.failed?.(address);
            if (blocked)
                this.#events.blocked?.(address, Math.round(blockMs / 1000));
        }
        catch {
            // 通知失败不影响封禁本身。
        }
    }
    /** 从状态目录加载持久化会话。 */
    #load() {
        if (!this.#file)
            return;
        try {
            const document = readJsonFile(this.#file, 64 * 1024);
            if (document === undefined)
                return;
            if (document?.version !== 1 ||
                typeof document.secretId !== "string" ||
                !Array.isArray(document.sessions) ||
                document.sessions.length > maxSessions)
                throw new Error("shape");
            if (document.secretId !== this.#secretId)
                return;
            for (const entry of document.sessions) {
                if (!entry ||
                    typeof entry.hash !== "string" ||
                    !/^[a-f0-9]{64}$/.test(entry.hash) ||
                    !validSession(entry.session))
                    throw new Error("session");
                if (entry.session.expiresAt > Date.now())
                    this.#sessions.set(entry.hash, entry.session);
            }
        }
        catch {
            this.#sessions.clear();
            throw new PanelError(500, M.web.sessionsCorrupt);
        }
    }
    /** 原子写入持久化会话。 */
    #persist() {
        if (!this.#file)
            return;
        const sessions = [...this.#sessions]
            .filter(([, session]) => session.remember)
            .map(([hash, session]) => ({ hash, session }));
        writeJsonFile(this.#file, { version: 1, secretId: this.#secretId, sessions });
    }
}
//# sourceMappingURL=auth.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("web/auth.ts", { PanelError, PanelAuth })
