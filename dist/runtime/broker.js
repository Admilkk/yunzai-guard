import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { hostDecision } from "../host/policy.js";
import { auditProtocol, copyAuditData, parseAuditFrame, } from "../audit/protocol.js";
import { M } from "../shared/messages.js";
/** 限制宿主实际 socket 写队列；尝试发送不代表对端已接收。 */
export function writeBrokerSocketFrame(socket, message, callback) {
    if (socket.destroyed)
        throw new Error(M.runtime.auditPeerGone);
    const line = JSON.stringify(copyAuditData(message)) + "\n";
    const bytes = Buffer.byteLength(line);
    if (bytes > 65536)
        throw new Error(M.runtime.auditReplyFrame);
    if (socket.writableLength + bytes > 256 * 1024)
        throw new Error(M.runtime.auditReplyQueue);
    return socket.write(line, callback);
}
/** 每代独立的审计端点，不执行管理命令或修改宿主设置。 */
export class RuntimeBroker {
    directory;
    manifestPath;
    #temporaryRoot;
    manifest;
    #peers = new Map();
    #onEvent;
    #audit;
    #server;
    #listenFailed = false;
    #closed = false;
    #closePromise;
    #preparing;
    #outbound = {
        offered: 0,
        submitted: 0,
        completed: 0,
        rejected: 0,
        sendErrors: 0,
        channelErrors: 0,
        unknown: 0,
        afterDropErrors: 0,
        closed: 0,
    };
    /** 返回各连接的传输计数汇总。 */
    transportStats() {
        return {
            scope: "broker-outbound-only",
            evidence: "transport-callback-only",
            provenance: "host-owned",
            ...this.#outbound,
        };
    }
    /** 记录一次出站发送失败，必要时断开该连接。 */
    outboundFailure(peer, channel = false) {
        peer.counters.sendErrors++;
        peer.counters.unknown++;
        const key = channel ? "channelErrors" : "sendErrors";
        this.#outbound[key] = Math.min(Number.MAX_SAFE_INTEGER, this.#outbound[key] + 1);
        this.#outbound.unknown = Math.min(Number.MAX_SAFE_INTEGER, this.#outbound.unknown + 1);
        if (peer.dropped)
            this.#outbound.afterDropErrors = Math.min(Number.MAX_SAFE_INTEGER, this.#outbound.afterDropErrors + 1);
    }
    /** 已完成握手的运行时数量。 */
    get activeRuntimes() {
        return [...this.#peers.values()].filter(peer => peer.id).length;
    }
    /** 创建运行时代理，负责接收子进程与线程的审计事件。 */
    constructor(settings, generation, projectId, onEvent, auditCallbacks) {
        this.#onEvent = onEvent;
        this.#audit = auditCallbacks;
        this.#temporaryRoot = fs.realpathSync.native(os.tmpdir());
        this.directory = fs.mkdtempSync(path.join(this.#temporaryRoot, "yunzai-guard-runtime-"));
        this.manifestPath = path.join(this.directory, "manifest.json");
        try {
            this.manifest = {
                version: 1,
                settings,
                generation,
                projectId,
                endpoint: process.platform === "win32"
                    ? `\\\\.\\pipe\\yunzai-guard-runtime-${randomBytes(16).toString("hex")}`
                    : path.join(this.directory, "broker.sock"),
                token: randomBytes(32).toString("hex"),
            };
            fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest), { mode: 0o400 });
        }
        catch (error) {
            try {
                this.removeDirectory();
            }
            catch (cleanupError) {
                throw new AggregateError([error, cleanupError], M.runtime.manifestCleanup);
            }
            throw error;
        }
    }
    /** 删除代理使用的私有套接字目录。 */
    removeDirectory() {
        const fold = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
        if (!path.isAbsolute(this.directory) ||
            fold(path.dirname(this.directory)) !== fold(this.#temporaryRoot) ||
            !path.basename(this.directory).startsWith("yunzai-guard-runtime-"))
            throw new Error(M.runtime.cleanupPath);
        let stat;
        try {
            stat = fs.lstatSync(this.directory);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return;
            throw error;
        }
        if (!stat.isDirectory() ||
            stat.isSymbolicLink() ||
            fold(fs.realpathSync.native(this.directory)) !== fold(this.directory))
            throw new Error(M.runtime.cleanupAliased);
        fs.rmSync(this.directory, { recursive: true, force: true });
    }
    /** 开始监听本地套接字；AppContainer 模式下由辅助进程提供管道。 */
    async listen(nativeWindowsPipe = false) {
        if (nativeWindowsPipe)
            return; // AppContainer 辅助进程持有按 SID 限制的命名管道。
        this.#server = net.createServer(socket => {
            socket.setEncoding("utf8");
            const key = randomBytes(16).toString("hex");
            if (this.#closed || this.#peers.size >= 128)
                return void socket.destroy();
            const peer = this.peer({
                send: (value, callback) => writeBrokerSocketFrame(socket, value, callback),
                close: () => socket.destroy(),
            });
            this.#peers.set(key, peer);
            let input = "";
            socket.setTimeout(5000, () => socket.destroy());
            socket.on("error", () => this.outboundFailure(peer, true));
            socket.on("close", () => this.dropPeer(key));
            socket.on("data", chunk => {
                input += chunk.toString("utf8");
                while (input.includes("\n")) {
                    const split = input.indexOf("\n");
                    const line = input.slice(0, split);
                    input = input.slice(split + 1);
                    if (Buffer.byteLength(line) > 65536)
                        return void socket.destroy();
                    try {
                        this.receive(key, JSON.parse(line));
                    }
                    catch {
                        socket.destroy();
                        return;
                    }
                    if (this.#peers.get(key)?.id)
                        socket.setTimeout(0);
                }
                if (Buffer.byteLength(input) > 65536)
                    socket.destroy();
            });
        });
        this.#server.on("error", () => { });
        try {
            await new Promise((resolve, reject) => {
                this.#server.once("error", reject);
                this.#server.listen(this.manifest.endpoint, resolve);
            });
        }
        catch (error) {
            this.#listenFailed = true;
            throw error;
        }
        this.#server.on("error", () => {
            /* 连接关闭后，现有客户端按拒绝策略处理。 */
        });
    }
    /** 原生辅助进程已确认连接的 Windows 进程属于当前 Job Object。 */
    receiveNative(key, message, send, close) {
        if (!this.#peers.has(key)) {
            if (this.#closed || this.#peers.size >= 128)
                return close();
            this.#peers.set(key, this.peer({ send, close }));
        }
        try {
            this.receive(key, message);
        }
        catch {
            const peer = this.#peers.get(key);
            try {
                close();
            }
            catch {
                if (peer)
                    this.outboundFailure(peer, true);
            }
            finally {
                this.dropPeer(key, "invalid-frame");
            }
        }
    }
    /** 断开由原生辅助进程转交的连接。 */
    dropNative(key) {
        this.dropPeer(key);
    }
    /** 为新连接创建对端状态。 */
    peer(io) {
        const peer = {
            ...io,
            dropped: false,
            channelNonce: randomBytes(24).toString("hex"),
            lastSequence: 0,
            counters: { received: 0, invalidFrames: 0, sendErrors: 0, unknown: 0 },
        };
        peer.send = message => {
            this.#outbound.offered = Math.min(Number.MAX_SAFE_INTEGER, this.#outbound.offered + 1);
            let settled = false;
            const complete = (error) => {
                if (settled)
                    return;
                settled = true;
                if (error)
                    this.outboundFailure(peer);
                else
                    this.#outbound.completed = Math.min(Number.MAX_SAFE_INTEGER, this.#outbound.completed + 1);
            };
            try {
                const result = io.send(message, complete);
                this.#outbound.submitted = Math.min(Number.MAX_SAFE_INTEGER, this.#outbound.submitted + 1);
                return result;
            }
            catch (error) {
                this.#outbound.rejected = Math.min(Number.MAX_SAFE_INTEGER, this.#outbound.rejected + 1);
                complete(error instanceof Error ? error : new Error(String(error)));
                throw error;
            }
        };
        return peer;
    }
    /** 断开连接并把其审计来源退役。 */
    dropPeer(key, reason = "channel-closed") {
        const peer = this.#peers.get(key);
        this.#peers.delete(key);
        if (peer) {
            peer.dropped = true;
            this.#outbound.closed = Math.min(Number.MAX_SAFE_INTEGER, this.#outbound.closed + 1);
        }
        if (!peer?.id)
            return;
        if (!peer.seal || !peer.flushResultSent)
            peer.counters.unknown++;
        this.#audit?.onDrop({ key, counters: { ...peer.counters }, reason });
        if (this.#closed)
            return;
        const event = {
            kind: "runtime",
            operation: "runtime-monitoring-degraded",
            target: peer.id,
            plugin: peer.originPlugin ?? "unknown",
            action: "audit",
            details: { reason: "channel-closed" },
        };
        const decision = hostDecision(this.manifest.settings, event);
        this.#onEvent(decision.action === "restart" ? "violation" : "audit", { ...event, ...decision });
    }
    /** 解析并分派一条入站消息：握手、审计帧或控制消息。 */
    receive(key, raw) {
        const peer = this.#peers.get(key);
        const copied = copyAuditData(raw);
        if (!peer ||
            this.#closed ||
            !copied ||
            typeof copied !== "object" ||
            Array.isArray(copied) ||
            Buffer.byteLength(JSON.stringify(copied)) > 65536)
            throw new Error(M.runtime.frame);
        const message = copied;
        if (!peer.id) {
            if (message.type !== "runtime-hello" ||
                message.version !== 1 ||
                message.token !== this.manifest.token ||
                typeof message.runtimeId !== "string" ||
                !/^[a-zA-Z0-9_-]{1,128}$/.test(message.runtimeId))
                throw new Error(M.runtime.identity);
            peer.id = message.runtimeId;
            peer.originPlugin =
                typeof message.originPlugin === "string" ? message.originPlugin.slice(0, 256) : "unknown";
            this.#audit?.onSource({
                key,
                generation: this.manifest.generation,
                channelNonce: peer.channelNonce,
                transport: "broker-connection",
                provenance: "host-owned-channel",
                runtimeIdLabel: peer.id,
            });
            peer.send({
                type: "runtime-ready",
                version: 1,
                runtimeId: peer.id,
                auditProtocol,
                generation: this.manifest.generation,
                channelNonce: peer.channelNonce,
            });
            this.#onEvent("audit", {
                kind: "runtime",
                operation: "runtime-registered",
                target: peer.id,
                plugin: typeof message.originPlugin === "string" ? message.originPlugin.slice(0, 256) : "unknown",
                action: "audit",
            });
            if (this.#preparing)
                this.preparePeer(peer, this.#preparing);
            return;
        }
        if (message.auditProtocol !== undefined) {
            const frame = parseAuditFrame(message);
            if (!frame ||
                frame.generation !== this.manifest.generation ||
                frame.channelNonce !== peer.channelNonce) {
                peer.counters.invalidFrames++;
                throw new Error(M.runtime.auditFrame);
            }
            const reply = value => this.reply(key, peer, value);
            if (frame.type === "audit-seal") {
                if (!this.#preparing ||
                    frame.closeNonce !== this.#preparing.nonce ||
                    peer.seal ||
                    frame.lastSentSeq !== peer.lastSequence) {
                    peer.counters.invalidFrames++;
                    throw new Error(M.runtime.auditSeal);
                }
                peer.seal = frame;
                this.#audit?.onSeal({ key, frame }, reply);
                return;
            }
            if (frame.type !== "audit" && frame.type !== "violation") {
                peer.counters.invalidFrames++;
                throw new Error(M.runtime.auditAction);
            }
            if (peer.seal || frame.auditSeq <= peer.lastSequence) {
                peer.counters.invalidFrames++;
                throw new Error(M.runtime.auditReplay);
            }
            if (frame.auditSeq !== peer.lastSequence + 1)
                peer.counters.unknown++;
            peer.lastSequence = frame.auditSeq;
            peer.counters.received++;
            if (this.#audit)
                this.#audit.onObservation({ key, frame }, reply);
            else {
                this.event(frame);
                reply({
                    type: "audit-hop-ack",
                    auditProtocol,
                    generation: this.manifest.generation,
                    channelNonce: peer.channelNonce,
                    auditSeq: frame.auditSeq,
                    result: "received",
                });
            }
            return;
        }
        if (message.type !== "audit" && message.type !== "violation")
            throw new Error(M.runtime.action);
        this.event(message);
    }
    /** 转交已校验的事件给宿主事件处理。 */
    event(message) {
        const event = message.event;
        if (!event ||
            typeof event !== "object" ||
            ![event.kind, event.operation, event.target].every(value => typeof value === "string" && value.length <= 4096))
            throw new Error(M.runtime.event);
        const { action: _reportedAction, ruleId: _reportedRule, ...observation } = event;
        const decision = hostDecision(this.manifest.settings, event);
        this.#onEvent(decision.action === "restart" ? "violation" : "audit", {
            ...observation,
            ...decision,
        });
    }
    /** 向对端回复确认或刷新结果帧。 */
    reply(key, peer, raw) {
        const frame = parseAuditFrame(raw);
        if (this.#peers.get(key) !== peer ||
            !frame ||
            frame.generation !== this.manifest.generation ||
            frame.channelNonce !== peer.channelNonce ||
            (frame.type !== "audit-hop-ack" && frame.type !== "audit-flush-result")) {
            peer.counters.invalidFrames++;
            return;
        }
        if ((frame.type === "audit-hop-ack" && frame.auditSeq > peer.lastSequence) ||
            (frame.type === "audit-flush-result" &&
                (!peer.seal ||
                    frame.closeNonce !== this.#preparing?.nonce ||
                    frame.cutoff !== peer.seal.lastSentSeq ||
                    frame.evidence !== "host-append-completed"))) {
            peer.counters.invalidFrames++;
            return;
        }
        try {
            peer.send(frame);
            if (frame.type === "audit-flush-result")
                peer.flushResultSent = true;
        }
        catch {
            /* 实际写入器已记录此失败，包括原生队列拒绝。 */
        }
    }
    /** 通知对端进入关闭阶段并开始刷新。 */
    preparePeer(peer, options) {
        if (!peer.id)
            return;
        try {
            peer.send({
                type: "audit-prepare-flush",
                auditProtocol,
                generation: this.manifest.generation,
                channelNonce: peer.channelNonce,
                closeNonce: options.nonce,
                remainingBudgetMs: Math.min(120000, Math.max(0, options.deadline.remainingMs())),
                scope: "this-source-only",
            });
        }
        catch {
            /* 已由当前对端的实际写入器计数。 */
        }
    }
    /** 这里只准备审计；资源关闭仍由原生命周期负责。 */
    prepareAudit(options) {
        if (!/^[a-zA-Z0-9_-]{16,128}$/.test(options.nonce))
            throw new Error(M.runtime.closeNonce);
        if (this.#closed)
            return;
        if (this.#preparing) {
            if (this.#preparing.nonce !== options.nonce)
                throw new Error(M.runtime.closePrepared);
            return;
        }
        this.#preparing = Object.freeze({ nonce: options.nonce, deadline: options.deadline });
        for (const peer of this.#peers.values())
            this.preparePeer(peer, this.#preparing);
    }
    /** 关闭代理，重复调用返回同一个 Promise。 */
    async close(options) {
        return (this.#closePromise ??= this.closeOnce(options));
    }
    /** 执行实际关闭：刷新各对端、断开连接并清理目录。 */
    async closeOnce(options) {
        if (this.#closed)
            return;
        if (options)
            this.prepareAudit(options);
        for (const peer of this.#peers.values()) {
            try {
                peer.send({
                    type: "runtime-stop",
                    ...(this.#preparing
                        ? {
                            generation: this.manifest.generation,
                            channelNonce: peer.channelNonce,
                            closeNonce: this.#preparing.nonce,
                            remainingBudgetMs: Math.min(120000, this.#preparing.deadline.remainingMs()),
                        }
                        : {}),
                });
            }
            catch {
                /* 已由当前对端的实际写入器计数。 */
            }
        }
        const deadline = this.#preparing?.deadline;
        while (deadline &&
            deadline.remainingMs() > 0 &&
            [...this.#peers.values()].some(peer => peer.id && (!peer.seal || !peer.flushResultSent)))
            await new Promise(resolve => setTimeout(resolve, Math.min(10, deadline.remainingMs())));
        this.#closed = true;
        const errors = [];
        for (const [key, peer] of this.#peers) {
            try {
                peer.close();
            }
            catch (error) {
                errors.push(error);
                this.outboundFailure(peer, true);
            }
            finally {
                try {
                    this.dropPeer(key, "broker-close");
                }
                catch (error) {
                    errors.push(error);
                }
            }
        }
        this.#peers.clear();
        if (this.#server) {
            try {
                await new Promise((resolve, reject) => this.#server.close(error => {
                    const neverListening = this.#listenFailed &&
                        !this.#server.listening &&
                        error?.code === "ERR_SERVER_NOT_RUNNING";
                    if (error && !neverListening)
                        reject(error);
                    else
                        resolve();
                }));
            }
            catch (error) {
                errors.push(error);
            }
        }
        // 仅允许处理在规范临时目录下新建的直接子目录。
        try {
            this.removeDirectory();
        }
        catch (error) {
            errors.push(error);
        }
        if (errors.length)
            throw new AggregateError(errors, M.runtime.brokerCleanup);
    }
}
//# sourceMappingURL=broker.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("runtime/broker.ts", { writeBrokerSocketFrame, RuntimeBroker })
