import fs from "node:fs";
import http from "node:http";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defaultTargets } from "../config/targets.js";
import { PanelAuth, PanelError } from "./auth.js";
import { guardSettingsPath, isPlainObject, listSandboxScripts, readSettingsDocument, serializeSettings, validateSettingsDocument, writeSettingsDocument, } from "./guard-settings.js";
import { loadPanelSettings, panelSettingsPath, savePanelSettings, } from "./panel-settings.js";
import { listPlugins } from "./plugins.js";
import { readAudit, pluginMonitor, nativeExtensions } from "./monitor.js";
import { handleExtra } from "./extra-api.js";
import { M } from "../shared/messages.js";
const maxBodyBytes = 1024 * 1024;
const staticDir = fileURLToPath(new URL("../panel/", import.meta.url));
const staticFiles = new Map([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/licenses.txt", "licenses.txt"],
]);
const sessionCookie = "guard_panel_session";
const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
};
/** 去掉 IPv4 映射前缀。 */
function normalizeAddress(address) {
    return address.startsWith("::ffff:") ? address.slice(7) : address;
}
/** 代理信任须显式开启，且只接受本机代理追加的最右侧地址。 */
function clientAddress(request, trustProxy) {
    const peer = normalizeAddress(request.socket.remoteAddress ?? "unknown");
    if (!trustProxy || (peer !== "127.0.0.1" && peer !== "::1"))
        return peer;
    const forwarded = request.headers["x-forwarded-for"];
    const last = (Array.isArray(forwarded) ? forwarded.at(-1) : forwarded)?.split(",").at(-1)?.trim();
    return last && isIP(last) ? normalizeAddress(last) : peer;
}
/** 根据 User-Agent 生成可读的设备名称。 */
function deviceName(agent) {
    const browser = /Edg\//.test(agent)
        ? "Edge"
        : /Firefox\//.test(agent)
            ? "Firefox"
            : /(?:Chrome|Chromium)\//.test(agent)
                ? "Chrome"
                : /Safari\//.test(agent)
                    ? "Safari"
                    : "浏览器";
    const system = /Windows/.test(agent)
        ? "Windows"
        : /Android/.test(agent)
            ? "Android"
            : /iPhone|iPad/.test(agent)
                ? "iOS"
                : /Macintosh/.test(agent)
                    ? "macOS"
                    : /Linux/.test(agent)
                        ? "Linux"
                        : "";
    return system ? `${browser} · ${system}` : `${browser}设备`;
}
/** 从 Cookie 中取出会话令牌。 */
function tokenOf(request) {
    for (const item of (request.headers.cookie ?? "").split(";")) {
        const [name, ...value] = item.trim().split("=");
        if (name === sessionCookie)
            return value.join("=");
    }
    const header = request.headers["guard-panel-token"] ?? request.headers["x-guard-token"];
    if (typeof header === "string" && header)
        return header;
    const authorization = request.headers.authorization;
    if (typeof authorization === "string" && authorization.startsWith("Bearer "))
        return authorization.slice(7).trim();
    return "";
}
/** 拒绝跨站请求。 */
function checkOrigin(request) {
    if (request.headers["sec-fetch-site"] === "cross-site")
        throw new PanelError(403, M.web.crossSite);
    const source = request.headers.origin;
    if (!source)
        return;
    try {
        const origin = new URL(source);
        if ((origin.protocol === "http:" || origin.protocol === "https:") &&
            origin.host === request.headers.host &&
            origin.origin === source)
            return;
    }
    catch { }
    throw new PanelError(403, M.web.originMismatch);
}
/** 写入会话 Cookie，HTTPS 时加 Secure。 */
function setSessionCookie(request, response, token, remembered, expiresAt = Date.now()) {
    const secure = Boolean(request.socket.encrypted) ||
        request.headers.origin?.startsWith("https://");
    const parts = [`${sessionCookie}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict"];
    if (!token)
        parts.push("Max-Age=0");
    else if (remembered)
        parts.push(`Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}`);
    if (secure)
        parts.push("Secure");
    response.setHeader("Set-Cookie", parts.join("; "));
}
/** 计算配置文本的版本摘要。 */
function revision(text) {
    return createHash("sha256").update(text).digest("hex");
}
/** 发送 JSON 响应。 */
function sendJson(response, status, body) {
    const text = JSON.stringify(body);
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(text),
        "Cache-Control": "no-store",
    });
    response.end(text);
}
/** 设置通用安全响应头。 */
function securityHeaders(response) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
}
/** 读取并解析有大小上限的 JSON 请求体。 */
function readBody(request) {
    return new Promise((resolve, reject) => {
        const declared = Number(request.headers["content-length"] ?? 0);
        if (declared > maxBodyBytes)
            return reject(new PanelError(413, M.web.bodyTooLarge));
        const chunks = [];
        let size = 0;
        request.on("data", chunk => {
            size += chunk.length;
            if (size > maxBodyBytes) {
                request.destroy();
                reject(new PanelError(413, M.web.bodyTooLarge));
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8").trim();
            if (!text)
                return resolve({});
            try {
                resolve(JSON.parse(text));
            }
            catch {
                reject(new PanelError(400, M.web.bodyJson));
            }
        });
        request.on("error", reject);
    });
}
export class GuardPanel {
    root;
    #options;
    #startedAt = Date.now();
    #codeRequests = new Map();
    #settings;
    #auth;
    #server;
    #listenHost;
    #streams = new Map();
    /** 创建面板服务。 */
    constructor(options) {
        this.root = options.root;
        this.#options = options;
        this.#settings = loadPanelSettings(options.stateDir);
        this.#auth = new PanelAuth(() => this.#settings, options.stateDir);
    }
    /** 当前面板配置。 */
    get settings() {
        return this.#settings;
    }
    /** 是否正在监听。 */
    get listening() {
        return Boolean(this.#server?.listening);
    }
    /** 实际监听端口。 */
    get port() {
        const address = this.#server?.address();
        return address && typeof address === "object" ? address.port : this.#settings.port;
    }
    /** 绑定 0.0.0.0 时同时给出回环与内网地址。 */
    get urls() {
        const host = this.#listenHost ?? this.#settings.host;
        const suffix = `:${this.port}/`;
        if (host !== "0.0.0.0" && host !== "::")
            return [`http://${host}${suffix}`];
        const result = [`http://127.0.0.1${suffix}`];
        for (const items of Object.values(os.networkInterfaces()))
            for (const item of items ?? [])
                if (item.family === "IPv4" && !item.internal)
                    result.push(`http://${item.address}${suffix}`);
        return result;
    }
    /** 启动面板服务并打印访问地址。 */
    async start() {
        if (!this.#settings.enabled) {
            this.#log(M.web.disabled);
            return false;
        }
        const server = http.createServer((request, response) => {
            securityHeaders(response);
            void this.#handle(request, response);
        });
        this.#server = server;
        const begin = Date.now();
        // 上次进程留下的验证码在内存里已失效，落盘副本不能继续误导。
        this.#clearCodeFile();
        const host = this.#settings.host;
        await this.#listen(server, host, this.#settings.port, 3);
        this.#listenHost = host;
        server.on("error", error => this.#log(M.web.serverError(error.message)));
        this.#banner(Date.now() - begin);
        this.#options.audit?.("panel-started", {
            host: this.#settings.host,
            port: this.port,
            tokenTtlHours: this.#settings.tokenTtlHours,
        });
        return true;
    }
    /** 停止面板服务。 */
    async stop() {
        const server = this.#server;
        this.#server = undefined;
        if (!server?.listening)
            return;
        for (const response of this.#streams.keys())
            response.end();
        this.#streams.clear();
        await new Promise(resolve => server.close(() => resolve()));
    }
    /** 监听端口，被占用时按次数重试。 */
    #listen(server, host, port, retries) {
        return new Promise((resolve, reject) => {
            const attempt = (remaining) => {
                const onError = (error) => {
                    server.off("listening", onListening);
                    if (error.code === "EADDRINUSE" && remaining > 0) {
                        this.#log(M.web.portRetry(port, 4 - remaining));
                        setTimeout(() => attempt(remaining - 1), 1000);
                        return;
                    }
                    reject(new Error(M.web.portUnavailable(port, error.code ?? error.message)));
                };
                const onListening = () => {
                    server.off("error", onError);
                    resolve();
                };
                server.once("error", onError);
                server.once("listening", onListening);
                server.listen({ host, port });
            };
            attempt(retries);
        });
    }
    /** 输出面板日志。 */
    #log(message) {
        this.#options.log?.(message);
    }
    /** 判断监听地址或端口是否需要重启面板。 */
    #panelRestartRequired() {
        return this.#settings.host !== this.#listenHost || this.#settings.port !== this.port;
    }
    /** 返回验证码文件路径。 */
    #codeFile() {
        return path.join(this.#options.stateDir, "login-code.txt");
    }
    /** 删除验证码文件。 */
    #clearCodeFile() {
        try {
            fs.rmSync(this.#codeFile(), { force: true });
        }
        catch {
            // 删除失败不影响登录本身。
        }
    }
    /** 打印面板地址横幅。 */
    #banner(elapsed) {
        const lines = [
            M.web.bannerStarted(elapsed),
            M.web.bannerUrls,
            ...this.urls,
            M.web.bannerHint,
            M.web.bannerCodeFile(this.#codeFile()),
            M.web.bannerWarn,
        ];
        for (const line of lines)
            this.#log(line);
    }
    /** 处理请求：静态资源或 API，并统一处理错误。 */
    async #handle(request, response) {
        try {
            const url = new URL(request.url ?? "/", "http://localhost");
            const method = request.method ?? "GET";
            if (method === "GET" || method === "HEAD") {
                if (await this.#serveStatic(url.pathname, request, response, method === "HEAD"))
                    return;
            }
            if (!url.pathname.startsWith("/api/"))
                return sendJson(response, 404, { error: M.web.notFound });
            await this.#api(request, response, url, method);
        }
        catch (error) {
            if (response.headersSent)
                return;
            if (error instanceof PanelError) {
                if (error.retryAfter)
                    response.setHeader("Retry-After", String(error.retryAfter));
                return sendJson(response, error.status, { error: error.message });
            }
            if (error instanceof TypeError)
                return sendJson(response, 400, { error: error.message });
            this.#log(M.web.requestFailed(error.message));
            return sendJson(response, 500, { error: M.web.internal });
        }
    }
    /** 提供面板静态资源，禁止越出面板目录。 */
    async #serveStatic(pathname, request, response, head) {
        const name = staticFiles.get(pathname) ??
            (/^\/assets\/[a-zA-Z0-9_-]+\.(?:js|css|svg|png|woff2)$/.test(pathname)
                ? pathname.slice(1)
                : undefined);
        if (!name)
            return false;
        const file = path.join(staticDir, name);
        let info;
        try {
            info = fs.statSync(file);
        }
        catch {
            sendJson(response, 404, { error: M.web.assetMissing });
            return true;
        }
        const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
        if (request.headers["if-none-match"] === etag) {
            response.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
            response.end();
            return true;
        }
        const body = fs.readFileSync(file);
        response.writeHead(200, {
            "Content-Type": contentTypes[path.extname(name)] ?? "application/octet-stream",
            "Content-Length": body.length,
            "Cache-Control": "no-cache",
            ETag: etag,
        });
        response.end(head ? undefined : body);
        return true;
    }
    /** 处理 API 请求。 */
    async #api(request, response, url, method) {
        const route = `${method} ${url.pathname}`;
        checkOrigin(request);
        if (!["GET", "HEAD"].includes(method) &&
            (Number(request.headers["content-length"]) > 0 || request.headers["transfer-encoding"]) &&
            !request.headers["content-type"]?.startsWith("application/json"))
            throw new PanelError(415, M.web.jsonRequired);
        if (route === "GET /api/meta")
            return sendJson(response, 200, {
                name: "Yunzai Guard",
                version: this.#options.version,
                hostPid: process.pid,
                auth: { method: "code", trustedDeviceTtlDays: this.#settings.trustedDeviceTtlDays },
            });
        if (route === "POST /api/login/code/request") {
            this.#limitCodeRequests(clientAddress(request, this.#settings.trustProxy));
            const code = this.#auth.requestCode();
            this.#printCode(code);
            return sendJson(response, 200, { ok: true });
        }
        if (route === "POST /api/login/code/check") {
            const body = await readBody(request);
            const code = isPlainObject(body) ? body.code : undefined;
            const token = this.#auth.checkCode(code, clientAddress(request, this.#settings.trustProxy), {
                remember: isPlainObject(body) && body.remember === true,
                userAgent: request.headers["user-agent"],
            });
            const payload = this.#auth.verify(token);
            const expiresAt = Number(payload.exp) * 1000;
            setSessionCookie(request, response, token, payload.remember === true, expiresAt);
            this.#clearCodeFile();
            this.#options.audit?.("panel-login", { remembered: payload.remember === true });
            return sendJson(response, 200, {
                ok: true,
                expiresAt,
                remembered: payload.remember === true,
                csrfToken: this.#auth.csrf(token),
            });
        }
        const token = tokenOf(request);
        const payload = this.#auth.verify(token);
        if (!payload)
            throw new PanelError(401, M.web.sessionExpired);
        if (!["GET", "HEAD"].includes(method) &&
            !this.#auth.verifyCsrf(token, request.headers["x-guard-csrf"]))
            throw new PanelError(403, M.web.csrf);
        if (route === "GET /api/session")
            return sendJson(response, 200, {
                username: "管理员",
                expiresAt: Number(payload.exp ?? 0) * 1000,
                tokens: this.#auth.tokenCount,
                remembered: payload.remember === true,
                sessionId: payload.jti,
                csrfToken: this.#auth.csrf(token),
            });
        if (route === "POST /api/logout") {
            this.#auth.logout(token);
            this.#closeRevokedStreams();
            setSessionCookie(request, response, "", false);
            return sendJson(response, 200, { ok: true });
        }
        if (route === "GET /api/security/sessions")
            return sendJson(response, 200, {
                sessions: this.#auth.sessions(token).map(item => ({
                    id: item.id,
                    name: deviceName(item.userAgent),
                    address: item.address,
                    createdAt: item.createdAt,
                    lastSeen: item.lastSeenAt,
                    expiresAt: item.expiresAt,
                    remembered: item.remember,
                    current: item.current,
                })),
            });
        if (method === "DELETE" &&
            /^\/api\/security\/sessions\/[a-zA-Z0-9_-]{8,128}$/.test(url.pathname)) {
            const id = url.pathname.slice("/api/security/sessions/".length);
            const revoked = this.#auth.revoke(id);
            this.#closeRevokedStreams();
            if (id === payload.jti)
                setSessionCookie(request, response, "", false);
            this.#options.audit?.("panel-session-revoked", { current: id === payload.jti });
            return sendJson(response, 200, { ok: true, revoked, current: id === payload.jti });
        }
        if (route === "GET /api/audit") {
            return sendJson(response, 200, readAudit(this.#options.stateDir, url.searchParams));
        }
        if (route === "GET /api/plugins") {
            const snapshot = readAudit(this.#options.stateDir);
            return sendJson(response, 200, {
                plugins: pluginMonitor(this.root, this.#options.getSettings?.() ?? this.#options.settings, snapshot),
                coverage: snapshot.coverage,
            });
        }
        if (route === "GET /api/logs") {
            // 宿主与业务进程的控制台输出都在 host.log；只回传末尾 256KB。
            const file = path.join(this.#options.stateDir, "host.log");
            let text = "(暂无日志)";
            try {
                const info = fs.statSync(file);
                const size = Math.min(info.size, 256 * 1024);
                const handle = fs.openSync(file, "r");
                try {
                    const buffer = Buffer.alloc(size);
                    fs.readSync(handle, buffer, 0, size, info.size - size);
                    text = buffer.toString("utf8");
                    // 截断可能落在多字节字符中间，切到下一行开头。
                    if (size < info.size)
                        text = text.slice(text.indexOf("\n") + 1);
                }
                finally {
                    fs.closeSync(handle);
                }
            }
            catch {
                // 文件尚未生成。
            }
            return sendJson(response, 200, { text, path: file });
        }
        if (route === "GET /api/logs/stream") {
            return this.#streamLogs(request, response, token);
        }
        if (route === "GET /api/overview") {
            const active = this.#options.getSettings?.() ?? this.#options.settings;
            const document = readSettingsDocument(this.#options.stateDir, active);
            const snapshot = readAudit(this.#options.stateDir);
            return sendJson(response, 200, {
                panel: {
                    host: this.#settings.host,
                    port: this.#settings.port,
                    listener: { host: this.#listenHost, port: this.port },
                    restartRequired: this.#panelRestartRequired(),
                    tokenTtlHours: this.#settings.tokenTtlHours,
                    trustedDeviceTtlDays: this.#settings.trustedDeviceTtlDays,
                    path: panelSettingsPath(this.#options.stateDir),
                    startedAt: this.#startedAt,
                },
                status: this.#options.status(),
                update: this.#options.update?.state(),
                plugins: listPlugins(this.root),
                audit: {
                    summary: snapshot.summary,
                    coverage: snapshot.coverage,
                    facets: snapshot.facets,
                    storage: snapshot.storage,
                },
                scripts: listSandboxScripts(this.#options.stateDir),
                native: nativeExtensions(this.#options.stateDir),
                defaults: { protectTargets: defaultTargets },
                active: serializeSettings(active),
                apply: this.#options.configuration?.(),
                pendingRestart: document.pendingRestart,
                paths: {
                    settings: guardSettingsPath(this.#options.stateDir),
                    panel: panelSettingsPath(this.#options.stateDir),
                    events: path.join(this.#options.stateDir, snapshot.storage?.engine === "sqlite" ? "events.sqlite" : "events.jsonl"),
                },
            });
        }
        if (route === "GET /api/settings") {
            const active = this.#options.getSettings?.() ?? this.#options.settings;
            const document = readSettingsDocument(this.#options.stateDir, active);
            return sendJson(response, 200, {
                ...document,
                revision: revision(document.text),
                active: serializeSettings(active),
                apply: this.#options.configuration?.(),
            });
        }
        if (route === "POST /api/settings/validate") {
            const body = await readBody(request);
            const value = isPlainObject(body) ? body.document : undefined;
            try {
                validateSettingsDocument(this.#options.stateDir, value);
            }
            catch (error) {
                return sendJson(response, 200, { ok: false, error: error.message });
            }
            return sendJson(response, 200, { ok: true });
        }
        if (route === "PUT /api/settings" || route === "POST /api/settings") {
            const body = await readBody(request);
            const active = this.#options.getSettings?.() ?? this.#options.settings;
            if (isPlainObject(body) && body.revision !== undefined) {
                const current = readSettingsDocument(this.#options.stateDir, active);
                if (typeof body.revision !== "string" || body.revision !== revision(current.text))
                    throw new PanelError(409, M.web.revision);
            }
            let value = isPlainObject(body) ? body.document : undefined;
            if (isPlainObject(body) && typeof body.raw === "string") {
                try {
                    value = JSON.parse(body.raw);
                }
                catch (error) {
                    throw new PanelError(400, M.web.jsonParse(error.message));
                }
            }
            let result;
            const normalized = validateSettingsDocument(this.#options.stateDir, value);
            try {
                result = writeSettingsDocument(this.#options.stateDir, active, value);
            }
            catch (error) {
                if (error instanceof TypeError)
                    throw error;
                throw new PanelError(500, M.web.writeFailed(error.message));
            }
            this.#options.audit?.("panel-settings-saved", {
                pendingRestart: result.pendingRestart,
                backup: result.backup ? "written" : "unavailable",
            });
            const apply = this.#options.applySettings?.(normalized);
            return sendJson(response, 200, { ok: true, ...result, apply });
        }
        if (route === "GET /api/update")
            return sendJson(response, 200, this.#options.update?.state() ?? null);
        if (route === "POST /api/update/check") {
            if (!this.#options.update)
                throw new PanelError(404, M.web.notFound);
            return sendJson(response, 200, await this.#options.update.check());
        }
        if (route === "POST /api/update/apply") {
            if (!this.#options.update)
                throw new PanelError(404, M.web.notFound);
            const body = await readBody(request);
            const result = await this.#options.update.apply(isPlainObject(body) && body.force === true);
            return sendJson(response, 200, { ...result, update: this.#options.update.state() });
        }
        if (route === "POST /api/update/rollback") {
            if (!this.#options.update)
                throw new PanelError(404, M.web.notFound);
            const result = await this.#options.update.rollback();
            return sendJson(response, 200, { ...result, update: this.#options.update.state() });
        }
        if (await handleExtra({
            stateDir: this.#options.stateDir,
            settings: this.#options.settings,
            getSettings: this.#options.getSettings,
            applySettings: this.#options.applySettings,
            controllers: this.#options.controllers,
            audit: this.#options.audit,
            readBody,
            sendJson,
            fail: (status, message) => new PanelError(status, message),
        }, route, url, request, response))
            return;
        if (route === "POST /api/actions/restart") {
            this.#options.restart();
            return sendJson(response, 200, { ok: true });
        }
        if (route === "POST /api/actions/resume") {
            this.#options.resume();
            return sendJson(response, 200, { ok: true });
        }
        if (route === "POST /api/panel") {
            const body = await readBody(request);
            if (!isPlainObject(body))
                throw new PanelError(400, M.web.bodyObject);
            let next;
            try {
                next = savePanelSettings(this.#options.stateDir, {
                    ...(body.host !== undefined ? { host: String(body.host) } : {}),
                    ...(body.port !== undefined ? { port: Number(body.port) } : {}),
                    ...(body.tokenTtlHours !== undefined
                        ? { tokenTtlHours: Number(body.tokenTtlHours) }
                        : {}),
                    ...(body.trustedDeviceTtlDays !== undefined
                        ? { trustedDeviceTtlDays: Number(body.trustedDeviceTtlDays) }
                        : {}),
                });
            }
            catch (error) {
                throw new PanelError(400, error.message);
            }
            this.#settings = next;
            return sendJson(response, 200, { ok: true, restartRequired: this.#panelRestartRequired() });
        }
        return sendJson(response, 404, { error: M.web.notFound });
    }
    /** 限制验证码请求频率。 */
    #limitCodeRequests(address) {
        const now = Date.now();
        // 表满时淘汰最早的记录，不整体清空，避免借大量地址重置所有限额。
        for (const [key, item] of this.#codeRequests)
            if (item.resetAt <= now || this.#codeRequests.size >= 512)
                this.#codeRequests.delete(key);
            else
                break;
        const record = this.#codeRequests.get(address);
        if (!record || record.resetAt <= now) {
            this.#codeRequests.set(address, { count: 1, resetAt: now + 600_000 });
            return;
        }
        record.count += 1;
        if (record.count > 10)
            throw new PanelError(429, M.web.codeRate);
    }
    /** 关闭已失效会话的日志流。 */
    #closeRevokedStreams() {
        for (const [response, token] of this.#streams)
            if (!this.#auth.verify(token))
                response.end();
    }
    /** SSE 实时日志流：300ms 增量推送 host.log 的新增内容，轮转/超限时整包重发。 */
    #streamLogs(request, response, token) {
        if (this.#streams.size >= 32)
            throw new PanelError(429, M.web.tooManyStreams);
        const file = path.join(this.#options.stateDir, "host.log");
        const maxTailBytes = 256 * 1024;
        response.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store",
        });
        response.flushHeaders();
        this.#streams.set(response, token);
        let offset = 0;
        let identity;
        let closed = false;
        let waitingDrain = false;
        let timer;
        let heartbeat;
        let drainTimer;
        const cleanup = () => {
            if (closed)
                return;
            closed = true;
            clearInterval(timer);
            clearInterval(heartbeat);
            clearTimeout(drainTimer);
            response.off("drain", resume);
            this.#streams.delete(response);
        };
        const disconnect = () => {
            cleanup();
            response.destroy();
        };
        const resume = () => {
            waitingDrain = false;
            clearTimeout(drainTimer);
            drainTimer = undefined;
        };
        const write = (text) => {
            if (closed || waitingDrain)
                return;
            if (response.writableLength + Buffer.byteLength(text) > maxTailBytes * 8)
                return disconnect();
            if (!response.write(text)) {
                waitingDrain = true;
                response.once("drain", resume);
                drainTimer = setTimeout(disconnect, 5000);
                drainTimer.unref();
            }
        };
        const send = (payload) => write(`data: ${JSON.stringify(payload)}\n\n`);
        const readChunk = () => {
            let handle;
            try {
                handle = fs.openSync(file, "r");
                const info = fs.fstatSync(handle);
                const nextIdentity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
                const reset = identity !== nextIdentity || info.size < offset || info.size - offset > maxTailBytes;
                let begin = reset ? Math.max(0, info.size - maxTailBytes) : offset;
                if (begin > 0) {
                    const byte = Buffer.alloc(1);
                    for (let index = 0; index < 3 && begin < info.size; index++) {
                        if (!fs.readSync(handle, byte, 0, 1, begin) || (byte[0] & 0xc0) !== 0x80)
                            break;
                        begin += 1;
                    }
                }
                const buffer = Buffer.alloc(Math.min(maxTailBytes, info.size - begin));
                const bytes = buffer.length ? fs.readSync(handle, buffer, 0, buffer.length, begin) : 0;
                return {
                    text: buffer.subarray(0, bytes).toString("utf8"),
                    end: begin + bytes,
                    identity: nextIdentity,
                    reset,
                };
            }
            catch {
                return undefined;
            }
            finally {
                if (handle !== undefined)
                    fs.closeSync(handle);
            }
        };
        request.once("close", cleanup);
        response.once("close", cleanup);
        const initial = readChunk();
        if (initial) {
            offset = initial.end;
            identity = initial.identity;
            send({ text: initial.text });
        }
        else
            send({ text: "" });
        timer = setInterval(() => {
            if (closed || waitingDrain)
                return;
            const chunk = readChunk();
            if (!chunk)
                return;
            const changed = chunk.reset || chunk.end !== offset;
            offset = chunk.end;
            identity = chunk.identity;
            if (changed)
                send(chunk.reset ? { text: chunk.text } : { append: chunk.text });
        }, 300);
        heartbeat = setInterval(() => {
            if (!this.#auth.verify(token))
                return response.end();
            write(": ping\n\n");
        }, 15000);
    }
    /** 在终端打印验证码，并写入状态目录文件。 */
    #printCode(code) {
        try {
            fs.writeFileSync(this.#codeFile(), `${code}\n`, { mode: 0o600 });
        }
        catch {
            // 落盘失败时仍尝试输出到控制台。
        }
        const line = "#".repeat(58);
        this.#log(line);
        this.#log(M.web.codeTitle);
        this.#log(M.web.codeValue(code));
        this.#log(M.web.codeTtl);
        this.#log(M.web.codeWarn);
        this.#log(line);
    }
}
//# sourceMappingURL=server.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("web/server.ts", { GuardPanel })
