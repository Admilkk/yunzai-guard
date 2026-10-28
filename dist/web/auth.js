import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { randomCode } from "./panel-settings.js";
import { M } from "../shared/messages.js";
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
const maxSessions = 32;
const maxAttempts = 1024;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
/** 计算 SHA-256 摘要。 */
const digest = (value) => createHash("sha256").update(value).digest("hex");
/** 以恒定时间比较两个秘密。 */
function sameSecret(a, b) {
    return timingSafeEqual(Buffer.from(digest(a), "hex"), Buffer.from(digest(b), "hex"));
}
/** 取字符串并截断，非字符串返回空串。 */
const text = (value, length) => typeof value === "string" ? value.slice(0, length) : "";
/** 校验持久化会话记录的结构。 */
function validSession(value) {
    if (!value || typeof value !== "object")
        return false;
    const item = value;
    return (typeof item.id === "string" &&
        /^[A-Za-z0-9_-]{16}$/.test(item.id) &&
        [item.createdAt, item.lastSeenAt, item.expiresAt].every(Number.isSafeInteger) &&
        item.createdAt > 0 &&
        item.createdAt <= item.lastSeenAt &&
        item.lastSeenAt <= item.expiresAt &&
        item.remember === true &&
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
    #code;
    /** 创建会话管理器，可选持久化到状态目录。 */
    constructor(settings, stateDir) {
        this.#settings = settings;
        this.#secretId = digest(settings().jwtSecret);
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
        this.#sessions.set(digest(token), record);
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
        const current = typeof currentToken === "string" ? digest(currentToken) : undefined;
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
        if (typeof token === "string" && this.#sessions.delete(digest(token)))
            this.#persist();
    }
    /** 生成一次性登录验证码，已有有效验证码时拒绝。 */
    requestCode() {
        if (this.#code && this.#code.expires > Date.now())
            throw new PanelError(429, M.web.codeActive);
        const value = randomCode(16);
        this.#code = { hash: digest(value), expires: Date.now() + codeTtlSeconds * 1000 };
        return value;
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
        if (!sameSecret(this.#code.hash, digest(code))) {
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
        const record = this.#sessions.get(digest(token));
        if (!record)
            return undefined;
        if (record.expiresAt <= Date.now()) {
            this.#sessions.delete(digest(token));
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
        if (++attempt.failures >= maxFailures) {
            attempt.failures = 0;
            attempt.blockedUntil = now + blockMs;
        }
        this.#attempts.set(address, attempt);
    }
    /** 从状态目录加载持久化会话。 */
    #load() {
        if (!this.#file)
            return;
        try {
            if (fs.statSync(this.#file).size > 64 * 1024)
                throw new Error("oversized");
            const document = JSON.parse(fs.readFileSync(this.#file, "utf8"));
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
        catch (error) {
            if (error.code !== "ENOENT") {
                this.#sessions.clear();
                throw new PanelError(500, M.web.sessionsCorrupt);
            }
        }
    }
    /** 原子写入持久化会话。 */
    #persist() {
        if (!this.#file)
            return;
        const sessions = [...this.#sessions]
            .filter(([, session]) => session.remember)
            .map(([hash, session]) => ({ hash, session }));
        const temporary = `${this.#file}.${randomBytes(6).toString("hex")}.tmp`;
        fs.mkdirSync(path.dirname(this.#file), { recursive: true });
        fs.writeFileSync(temporary, JSON.stringify({ version: 1, secretId: this.#secretId, sessions }) + "\n", { mode: 0o600 });
        try {
            fs.renameSync(temporary, this.#file);
        }
        finally {
            if (fs.existsSync(temporary))
                fs.rmSync(temporary, { force: true });
        }
    }
}
//# sourceMappingURL=auth.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("web/auth.ts", { PanelError, PanelAuth })
