import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isSupportedPm2Version } from "./versions.js";
import { performance } from "node:perf_hooks";
import { createNativeIdentityAdapter, } from "../native-process/index.js";
import { M } from "../shared/messages.js";
/** 创建 Inspector 操作的截止时间。 */
export function inspectorDeadline(budgetMs) {
    if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0)
        throw new Error(M.pm2.attachBudget);
    const expires = performance.now() + budgetMs;
    return Object.freeze({ remainingMs: () => Math.max(0, expires - performance.now()) });
}
/** 返回剩余毫秒数，已超时则抛错。 */
function remaining(deadline, maximum = 2147483647) {
    const value = Math.floor(deadline.remainingMs());
    if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(M.pm2.attachDeadline);
    return Math.min(value, maximum);
}
/** 等待指定毫秒数。 */
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
/** 解析父进程身份记录。 */
export function parseParentRecord(value, pid) {
    if (!value || typeof value !== "object")
        throw new Error(M.pm2.parentRecord);
    const item = value;
    if (item.pid !== pid ||
        typeof item.created !== "string" ||
        !/^\d+$/.test(item.created) ||
        typeof item.commandLine !== "string" ||
        !item.commandLine ||
        item.commandLine.length > 65536)
        throw new Error(M.pm2.parentRecord);
    return item;
}
/** 解析 Windows 监听端口列表。 */
export function parseWindowsListeners(text, pid) {
    if (text.length > 4 * 1024 * 1024)
        throw new Error(M.pm2.listenerLimit);
    const result = [];
    for (const line of text.split(/\r?\n/)) {
        const fields = line.trim().split(/\s+/);
        if (fields[0] !== "TCP" || fields[3] !== "LISTENING" || fields[4] !== String(pid))
            continue;
        const match = /^(127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):(\d+)$/.exec(fields[1] ?? "");
        const port = Number(match?.[2]);
        if (match && port > 0 && port < 65536)
            result.push({ host: match[1].replace(/^\[|\]$/g, ""), port });
    }
    return result;
}
/** 解析 Inspector 回复。 */
export function parseInspectorReply(text) {
    if (text.length > 1024 * 1024)
        return null;
    try {
        const value = JSON.parse(text);
        return value && typeof value === "object" ? value : null;
    }
    catch {
        return null;
    }
}
/** 运行时描述不可信；只保留简短原因，不保留表达式或堆栈。 */
export function safeRuntimeError(details) {
    let description;
    if (details && typeof details === "object") {
        const exception = details.exception;
        if (exception && typeof exception === "object")
            description = exception.description;
    }
    if (typeof description !== "string" || !description)
        return "PM2 daemon registration Runtime operation failed";
    const first = description.split(/[\r\n]/, 1)[0].slice(0, 4096);
    const sanitized = first
        .replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [REDACTED]")
        .replace(/\b(token|password|passwd|nonce|secret|authorization|api[_-]?key)\b["']?\s*[:=]\s*(?:"[^"]*"?|'[^']*'?|[^\s,;}]+)/gi, "$1=[REDACTED]")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .slice(0, 240);
    return "PM2 daemon registration Runtime operation failed: " + sanitized;
}
/** 拒绝会将新激活端点暴露到非回环地址的可见调试配置。 */
export function assertLoopbackInspectorArguments(commandLine) {
    const tokens = commandLine.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index].replace(/^(["'])(.*)\1$/, "$2");
        const match = /^--inspect(?:-port|-brk|-wait)?(?:=(.*))?$/.exec(token);
        if (!match)
            continue;
        let value = match[1];
        if (value === undefined && token === "--inspect-port")
            value = tokens[++index];
        if (value === undefined || value === "")
            continue;
        value = value.replace(/^(["'])(.*)\1$/, "$2");
        if (/^\d+$/.test(value) && Number(value) <= 65535)
            continue;
        const endpoint = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/.exec(value);
        if (endpoint && (endpoint[2] === undefined || Number(endpoint[2]) <= 65535))
            continue;
        throw new Error(M.pm2.nonLoopbackArgs);
    }
}
/** 只读取当前直接父进程身份，不通过全局 PM2 socket 选择守护进程。 */
export function readParentProof() {
    const pid = process.ppid;
    if (!Number.isSafeInteger(pid) || pid <= 1)
        throw new Error(M.pm2.parentUnavailable);
    if (process.platform === "win32") {
        const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop;if($null -eq $p){exit 2};@{pid=[int]$p.ProcessId;created=$p.CreationDate.ToUniversalTime().Ticks.ToString();commandLine=$p.CommandLine}|ConvertTo-Json -Compress`;
        const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
        return parseParentRecord(JSON.parse(raw), pid);
    }
    if (process.platform !== "linux")
        throw new Error(M.pm2.autoPlatform);
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return {
        pid,
        created: stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19],
        commandLine: fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim(),
    };
}
/** 确认父进程身份未变。 */
export function assertParentUnchanged(proof) {
    const current = readParentProof();
    if (current.pid !== proof.pid || current.created !== proof.created)
        throw new Error(M.pm2.parentCreated);
}
/** 确认父进程为 PM2 daemon。 */
export function assertParentProof(proof, home) {
    if (proof.pid !== process.ppid || !/^\d+$/.test(proof.created) || !home)
        throw new Error(M.pm2.parentIdentity);
    const file = path.join(home, "pm2.pid");
    if (Number(fs.readFileSync(file, "utf8").trim()) !== proof.pid)
        throw new Error(M.pm2.pm2Home);
    assertLoopbackInspectorArguments(proof.commandLine);
    const daemonPath = (proof.commandLine.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
        .map(token => token.replace(/^(["'])(.*)\1$/, "$2"))
        .find(token => /[\\/]lib[\\/]Daemon\.js$/.test(token));
    let validPath = false;
    if (daemonPath) {
        try {
            const metadata = JSON.parse(fs.readFileSync(path.join(path.dirname(daemonPath), "../package.json"), "utf8"));
            validPath = metadata.name === "pm2" && isSupportedPm2Version(metadata.version);
        }
        catch {
            /* 命令行仅作证据，不能授权加载任意代码。 */
        }
    }
    // Linux process.title 受原始 argv 存储长度限制，主目录路径及右括号可能被截断。
    // 此信息仅作预检线索，实际模块由 Runtime 验证。
    const titleVersion = /^PM2 v([^:]+): God Daemon \(.+/.exec(proof.commandLine)?.[1];
    if (!validPath && !isSupportedPm2Version(titleVersion))
        throw new Error(M.pm2.parentNotPm2);
}
/** 列出进程的监听端口。 */
function listeners(pid, deadline) {
    if (deadline)
        remaining(deadline);
    if (process.platform === "win32") {
        const raw = execFileSync("netstat.exe", ["-ano", "-p", "TCP"], {
            encoding: "utf8",
            windowsHide: true,
            timeout: deadline ? remaining(deadline, 3000) : 3000,
            maxBuffer: 4 * 1024 * 1024,
        });
        return parseWindowsListeners(raw, pid);
    }
    const inodes = new Set();
    for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
        try {
            const match = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
            if (match)
                inodes.add(match[1]);
        }
        catch {
            /* 枚举期间 socket 可能已经关闭。 */
        }
    }
    const result = [];
    for (const table of ["tcp", "tcp6"]) {
        for (const line of fs
            .readFileSync(`/proc/${pid}/net/${table}`, "utf8")
            .trim()
            .split("\n")
            .slice(1)) {
            const fields = line.trim().split(/\s+/);
            if (fields[3] !== "0A" || !inodes.has(fields[9]))
                continue;
            const [address, port] = fields[1].split(":");
            const host = address === "0100007F"
                ? "127.0.0.1"
                : address === "00000000"
                    ? "0.0.0.0"
                    : address === "00000000000000000000000001000000"
                        ? "::1"
                        : address === "00000000000000000000000000000000"
                            ? "::"
                            : null;
            if (host)
                result.push({ host, port: parseInt(port, 16) });
        }
    }
    return result;
}
/** 把通配监听地址转为回环地址。 */
const loopbackHost = (host) => host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
/** 返回监听端点的 HTTP 源。 */
const origin = (listener) => {
    const host = loopbackHost(listener.host);
    return `http://${host === "::1" ? "[::1]" : host}:${listener.port}`;
};
/** 规范化 Inspector 宣告的端点。 */
export function normalizeInspectorEndpoint(advertised, listener) {
    try {
        const url = new URL(advertised);
        if (url.protocol !== "ws:" ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            !["127.0.0.1", "[::1]", "::1", "localhost", "0.0.0.0", "[::]", "::"].includes(url.hostname) ||
            Number(url.port) !== listener.port)
            return null;
        const connect = new URL(advertised);
        const host = loopbackHost(listener.host);
        connect.hostname = host === "::1" ? "[::1]" : host;
        return {
            url: advertised,
            connectUrl: connect.href,
            wildcard: listener.host === "0.0.0.0" || listener.host === "::",
        };
    }
    catch {
        return null;
    }
}
/** 判断宣告端点与实际监听是否为同一目标。 */
export function sameInspectorTarget(advertised, actual, wildcard) {
    try {
        const before = new URL(advertised), after = new URL(actual);
        const loopback = ["127.0.0.1", "[::1]", "::1", "localhost"];
        const wildcards = ["0.0.0.0", "[::]", "::"];
        return (before.protocol === "ws:" &&
            after.protocol === "ws:" &&
            !before.username &&
            !before.password &&
            !after.username &&
            !after.password &&
            !before.search &&
            !before.hash &&
            !after.search &&
            !after.hash &&
            before.port === after.port &&
            before.pathname === after.pathname &&
            (wildcard
                ? [...loopback, ...wildcards].includes(before.hostname) &&
                    wildcards.includes(after.hostname)
                : loopback.includes(before.hostname) && loopback.includes(after.hostname)));
    }
    catch {
        return false;
    }
}
/** 发现进程的 Inspector 调试目标。 */
async function discover(pid, deadline) {
    const owned = listeners(pid, deadline);
    if (owned.length > 32)
        throw new Error(M.pm2.listenerCandidates);
    let loopback;
    for (const listener of owned) {
        const timeout = remaining(deadline, 800);
        try {
            const response = await fetch(origin(listener) + "/json/list", {
                signal: AbortSignal.timeout(timeout),
                redirect: "error",
            });
            const raw = await limitedBody(response);
            const targets = JSON.parse(raw);
            if (!Array.isArray(targets))
                continue;
            for (const target of targets) {
                if (target.type !== "node" || typeof target.webSocketDebuggerUrl !== "string")
                    continue;
                const endpoint = normalizeInspectorEndpoint(target.webSocketDebuggerUrl, listener);
                if (endpoint?.wildcard)
                    return endpoint;
                if (endpoint)
                    loopback ??= endpoint;
            }
        }
        catch {
            /* 不修改非 Inspector 监听器。 */
        }
    }
    return loopback;
}
/** 读取有大小上限的响应体。 */
async function limitedBody(response) {
    if (!response.body)
        throw new Error(M.pm2.discoveryEmpty);
    const reader = response.body.getReader(), chunks = [];
    let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            length += value.byteLength;
            if (length > 65536)
                throw new Error(M.pm2.discoveryLimit);
            chunks.push(value);
        }
        return Buffer.concat(chunks).toString("utf8");
    }
    finally {
        await reader.cancel().catch(() => { });
    }
}
/** 在截止时间内关闭 WebSocket。 */
async function disconnectSocket(socket, deadline) {
    if (socket.readyState === WebSocket.CLOSED)
        return;
    let timeout;
    try {
        timeout = remaining(deadline, 5000);
    }
    catch (error) {
        socket.close();
        throw error;
    }
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(M.pm2.disconnectTimeout)), timeout);
        socket.addEventListener("close", () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
        try {
            socket.close();
        }
        catch (error) {
            clearTimeout(timer);
            reject(error);
        }
    });
}
export class ParentInspector {
    socket;
    endpointUrl;
    opened;
    proof;
    wildcard;
    connectUrl;
    nativeParent;
    deadline;
    serial = 0;
    confirmationSerial = 1;
    identityValidated = false;
    closePromise;
    pending = new Map();
    /** 创建 Inspector 会话。 */
    constructor(socket, endpointUrl, opened, proof, wildcard, connectUrl, nativeParent, deadline) {
        this.socket = socket;
        this.endpointUrl = endpointUrl;
        this.opened = opened;
        this.proof = proof;
        this.wildcard = wildcard;
        this.connectUrl = connectUrl;
        this.nativeParent = nativeParent;
        this.deadline = deadline;
        socket.addEventListener("message", event => {
            if (typeof event.data !== "string" || event.data.length > 1024 * 1024) {
                socket.close();
                return;
            }
            const message = parseInspectorReply(event.data);
            if (!message) {
                socket.close();
                return;
            }
            const request = message.id ? this.pending.get(message.id) : undefined;
            if (!request)
                return;
            this.pending.delete(message.id);
            clearTimeout(request.timer);
            if (message.error)
                request.reject(new Error(M.pm2.runtimeRejected));
            else
                request.resolve(message.result);
        });
        socket.addEventListener("close", () => {
            for (const request of this.pending.values()) {
                clearTimeout(request.timer);
                request.reject(new Error(M.pm2.sessionClosed));
            }
            this.pending.clear();
        });
    }
    /** 调试端点地址。 */
    get url() {
        return this.endpointUrl;
    }
    /** 核验父进程并连接其 Inspector。 */
    static async connect(proof, options = {}) {
        const deadline = options.deadline ?? inspectorDeadline(15000);
        const nativeParent = await (options.nativeIdentity ?? createNativeIdentityAdapter()).openInspectorParent({
            remainingBudgetMs: remaining(deadline),
        });
        let socket;
        let activationAttempted = false;
        try {
            if (nativeParent.parent.pid !== proof.pid)
                throw new Error(M.pm2.nativeParentDiffers);
            const observe = options.discover ?? discover;
            let endpoint = await observe(proof.pid, deadline);
            if (endpoint?.wildcard)
                throw new Error(M.pm2.existingWildcard);
            const opened = !endpoint;
            if (!endpoint) {
                if (!nativeParent.activationAvailable)
                    throw new Error(M.pm2.activationRefused(nativeParent.unavailableReason ?? "UNSUPPORTED_NODE_PROFILE"));
                activationAttempted = true;
                remaining(deadline);
                const activated = await nativeParent.activateOnce();
                if (activated.result !== "native-action-completed")
                    throw new Error(M.pm2.activationUnconfirmed);
                for (let attempt = 0; attempt < 8 && !endpoint; attempt++) {
                    await pause(Math.min(50, remaining(deadline)));
                    endpoint = await observe(proof.pid, deadline);
                }
                if (!endpoint)
                    throw new Error(M.pm2.endpointOwner);
            }
            remaining(deadline);
            const client = (socket = new WebSocket(endpoint.connectUrl));
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    client.close();
                    reject(new Error(M.pm2.connectTimeout));
                }, remaining(deadline, 5000));
                client.addEventListener("open", () => {
                    clearTimeout(timer);
                    resolve();
                }, { once: true });
                client.addEventListener("error", () => {
                    clearTimeout(timer);
                    client.close();
                    reject(new Error(M.pm2.connectFailed));
                }, { once: true });
            });
            // 打开此 WebSocket 后立即重新观察持有对象；此前不执行 Runtime 代码。
            const confirmed = await nativeParent.confirmAfterWebSocket(1);
            if (!confirmed.originalLive || confirmed.parent.pid !== proof.pid)
                throw new Error(M.pm2.confirmMismatch);
            return new ParentInspector(client, endpoint.url, opened, proof, endpoint.wildcard, endpoint.connectUrl, nativeParent, deadline);
        }
        catch (error) {
            const errors = [error];
            if (socket)
                await disconnectSocket(socket, deadline).catch(failure => errors.push(failure));
            await nativeParent.close().catch(failure => errors.push(failure));
            if (activationAttempted || errors.length > 1)
                throw new AggregateError(errors, M.pm2.attachFailed);
            throw error;
        }
    }
    /** 在 daemon 中求值表达式。 */
    async evaluate(expression) {
        await this.verifyParent();
        const id = ++this.serial;
        const result = (await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(M.pm2.runtimeTimeout));
            }, remaining(this.deadline, 10000));
            this.pending.set(id, { resolve, reject, timer });
            this.socket.send(JSON.stringify({
                id,
                method: "Runtime.evaluate",
                params: { expression, returnByValue: true, awaitPromise: true },
            }));
        }));
        if (result.exceptionDetails)
            throw new Error(safeRuntimeError(result.exceptionDetails));
        return result.result?.value;
    }
    /** 读取 daemon 身份。 */
    async identity() {
        const identity = await this.evaluate(`(()=>{const f=process.getBuiltinModule('fs'),p=process.getBuiltinModule('path'),r=process.getBuiltinModule('module').createRequire(process.argv[1]);const main=f.realpathSync.native(process.argv[1]),root=f.realpathSync.native(p.join(p.dirname(main),'..')),pkg=JSON.parse(f.readFileSync(p.join(root,'package.json'),'utf8'));return {pid:process.pid,main,pm2Root:root,name:pkg.name,version:pkg.version,godCached:Boolean(r.cache[r.resolve(p.join(root,'lib/God.js'))]?.loaded),inspectorUrl:process.getBuiltinModule('inspector').url()}})()`);
        if (identity.pid !== this.proof.pid ||
            identity.name !== "pm2" ||
            !isSupportedPm2Version(identity.version) ||
            !identity.godCached ||
            !sameInspectorTarget(this.url, identity.inspectorUrl, this.wildcard) ||
            path.basename(identity.main) !== "Daemon.js" ||
            path.basename(path.dirname(identity.main)) !== "lib")
            throw new Error(M.pm2.runtimeIdentity);
        // 发现阶段使用 HTTP Host 头；清理必须匹配 Node 实际绑定的 URL。
        this.endpointUrl = identity.inspectorUrl;
        this.identityValidated = true;
        return identity;
    }
    /** 复查父进程身份与剩余时间。 */
    async verifyParent() {
        remaining(this.deadline);
        const confirmed = await this.nativeParent.confirmAfterWebSocket(++this.confirmationSerial);
        if (!confirmed.originalLive || confirmed.parent.pid !== this.proof.pid)
            throw new Error(M.pm2.nativeParentChanged);
    }
    /** 关闭会话，重复调用返回同一个 Promise。 */
    async close(closeOwnedEndpoint) {
        return (this.closePromise ??= this.closeOnce(closeOwnedEndpoint));
    }
    /** 执行实际关闭。 */
    async closeOnce(closeOwnedEndpoint) {
        let failure;
        try {
            await this.closeEndpoint(closeOwnedEndpoint);
        }
        catch (error) {
            failure = error;
        }
        try {
            await this.nativeParent.close();
        }
        catch (error) {
            if (failure)
                throw new AggregateError([failure, error], M.pm2.sessionCleanup);
            throw error;
        }
        if (failure)
            throw failure;
    }
    /** 断开连接并关闭本会话打开的端点。 */
    async closeEndpoint(closeOwnedEndpoint) {
        await disconnectSocket(this.socket, this.deadline);
        if (this.opened && !this.identityValidated)
            throw new Error(M.pm2.identityUnverified);
        if (this.opened) {
            if (!closeOwnedEndpoint)
                throw new Error(M.pm2.cleanupNotPrepared);
            // 在 Inspector 自己的 Runtime 处理器中关闭它，可能与 Node 原生 CDP 清理竞争。
            // 因此等待 WebSocket 关闭后，再通过已验证的子进程 IPC 执行此回调。
            await this.verifyParent();
            await closeOwnedEndpoint();
            const endpoint = new URL(this.connectUrl);
            for (let attempt = 0; attempt < 20; attempt++) {
                let present = true;
                try {
                    const response = await fetch(`http://${endpoint.host}/json/list`, {
                        signal: AbortSignal.timeout(remaining(this.deadline, 300)),
                        redirect: "error",
                    });
                    const targets = JSON.parse(await limitedBody(response));
                    present =
                        Array.isArray(targets) &&
                            targets.some(target => target.webSocketDebuggerUrl === this.url);
                }
                catch {
                    present = false;
                }
                if (!present &&
                    !listeners(this.proof.pid, this.deadline).some(listener => listener.port === Number(endpoint.port))) {
                    await this.verifyParent();
                    return;
                }
                await pause(Math.min(25, remaining(this.deadline)));
            }
            throw new Error(M.pm2.endpointOpen);
        }
    }
}
//# sourceMappingURL=inspector.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("pm2/inspector.ts", { inspectorDeadline, parseParentRecord, parseWindowsListeners, parseInspectorReply, safeRuntimeError, assertLoopbackInspectorArguments, readParentProof, assertParentUnchanged, assertParentProof, normalizeInspectorEndpoint, sameInspectorTarget, ParentInspector })
