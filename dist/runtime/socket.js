import net from "node:net";
import { AuditSender } from "../audit/sender.js";
import { auditProtocol, createAuditDeadline, parseAuditFrame, stringifyAuditData, } from "../audit/protocol.js";
import { addInvalidReplies, createReporter, reportFailure } from "./reporter.js";
import { arrayIsArray, bufferByteLength, jsonParse, mathMin, numberIsFinite, promiseThen, regexpTest, stringIndexOf, stringSlice, } from "../protect/intrinsics.js";
import { M } from "../shared/messages.js";
const rawExit = process.exit.bind(process);
const connect = net.createConnection.bind(net);
const AsyncPromise = Promise;
const schedule = setTimeout;
const number = Number;
/** 通过本地套接字把 Node 子进程运行时接入宿主代理。 */
export function connectSocket(manifest, identity, lifecycle) {
    const socket = connect(manifest.endpoint);
    socket.setEncoding("utf8");
    let online = false;
    let input = "";
    let degraded = false;
    let exiting = false;
    let stopping = false;
    let channelNonce;
    let prepared;
    let seal;
    let receivedResult = false;
    let invalidReplies = 0;
    const sender = new AuditSender({
        generation: identity.generation,
        maxQueue: manifest.settings.audit.maxQueue,
        maxBytes: 256 * 1024,
        completion: "hop",
        isConnected: () => !degraded && !socket.destroyed,
        /** 按行写入审计帧。 */
        write(frame, callback) {
            return socket.write(stringifyAuditData(frame) + "\n", callback);
        },
    });
    const nestedCoverage = createReporter(sender, identity, lifecycle.coverage);
    let resolveReady = () => { };
    let rejectReady = () => { };
    const ready = new AsyncPromise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    void promiseThen(ready, () => { }, () => { });
    const fail = (reason) => {
        if (degraded)
            return;
        degraded = true;
        online = false;
        sender.dispose();
        socket.setTimeout(0);
        socket.destroy();
        const decision = exiting
            ? { action: "audit" }
            : reportFailure(manifest.settings, identity, reason);
        if (decision.action === "audit")
            resolveReady();
        else
            rejectReady(new Error(M.runtime.telemetryFailed(reason)));
    };
    socket.setTimeout(manifest.settings.handshakeTimeout, () => fail("runtime-broker-handshake-timeout"));
    socket.on("error", () => fail("runtime-broker-error"));
    socket.on("close", () => fail("runtime-broker-disconnected"));
    socket.on("drain", () => sender.resume());
    socket.on("connect", () => socket.write(stringifyAuditData({
        type: "runtime-hello",
        version: 1,
        token: manifest.token,
        runtimeId: identity.id,
        parentRuntimeId: identity.parentId,
        originPlugin: identity.originPlugin,
        pid: process.pid,
        kind: identity.kind,
    }) + "\n"));
    const prepare = (frame) => {
        if (prepared)
            return prepared.nonce === frame.closeNonce;
        prepared = { nonce: frame.closeNonce, deadline: createAuditDeadline(frame.remainingBudgetMs) };
        lifecycle.prepare(prepared);
        return true;
    };
    const stop = async () => {
        if (stopping)
            return;
        stopping = true;
        if (!prepared)
            return rawExit(0);
        try {
            lifecycle.dispose();
            seal = await sender.seal({
                ...prepared,
                nestedCoverage: nestedCoverage(),
            });
            seal = addInvalidReplies(seal, invalidReplies);
            if (!degraded)
                socket.write(stringifyAuditData(seal) + "\n");
            while (!receivedResult && !degraded && prepared.deadline.remainingMs() > 0)
                await new AsyncPromise(resolve => schedule(resolve, mathMin(5, prepared.deadline.remainingMs())));
        }
        catch {
            // 审计传输失败不改变原 runtime-stop 的退出状态。
        }
        finally {
            exiting = true;
            sender.dispose();
            rawExit(0);
        }
    };
    socket.on("data", (chunk) => {
        input += chunk;
        let newline;
        while ((newline = stringIndexOf(input, "\n")) >= 0) {
            const line = stringSlice(input, 0, newline);
            input = stringSlice(input, newline + 1);
            if (bufferByteLength(line) > 65536)
                return fail("runtime-broker-frame-too-large");
            let message;
            try {
                const parsed = jsonParse(line);
                if (!parsed || typeof parsed !== "object" || arrayIsArray(parsed))
                    return fail("invalid-runtime-broker-frame");
                message = parsed;
            }
            catch {
                return fail("invalid-runtime-broker-frame");
            }
            if (message.type === "runtime-stop") {
                // 只有原生命周期命令能够从外部请求退出此运行时。
                if (!prepared && message.closeNonce === undefined)
                    return rawExit(0);
                if (!prepared ||
                    message.generation !== identity.generation ||
                    message.channelNonce !== channelNonce ||
                    message.closeNonce !== prepared.nonce)
                    return fail("unexpected-runtime-stop");
                const budget = number(message.remainingBudgetMs);
                if (!numberIsFinite(budget) || budget < 0 || budget > 120000)
                    return fail("invalid-runtime-stop-budget");
                const previousDeadline = prepared.deadline;
                const tightened = createAuditDeadline(mathMin(budget, previousDeadline.remainingMs()));
                prepared = {
                    ...prepared,
                    deadline: {
                        remainingMs: () => mathMin(previousDeadline.remainingMs(), tightened.remainingMs()),
                    },
                };
                void stop();
                return;
            }
            if (message.auditProtocol !== undefined && message.type !== "runtime-ready") {
                const frame = parseAuditFrame(message);
                if (!frame ||
                    frame.generation !== identity.generation ||
                    frame.channelNonce !== channelNonce) {
                    invalidReplies++;
                    continue;
                }
                if (frame.type === "audit-hop-ack") {
                    if (!sender.ack(frame))
                        invalidReplies++;
                }
                else if (frame.type === "audit-prepare-flush") {
                    if (!prepare(frame))
                        invalidReplies++;
                }
                else if (frame.type === "audit-flush-result") {
                    if (!prepared ||
                        !seal ||
                        frame.closeNonce !== prepared.nonce ||
                        frame.cutoff !== seal.lastSentSeq ||
                        frame.evidence !== "host-append-completed") {
                        invalidReplies++;
                        continue;
                    }
                    receivedResult = true;
                }
                else
                    invalidReplies++;
                continue;
            }
            if (message.type !== "runtime-ready" ||
                online ||
                message.runtimeId !== identity.id ||
                message.auditProtocol !== auditProtocol ||
                message.generation !== identity.generation ||
                typeof message.channelNonce !== "string" ||
                !regexpTest(/^[a-f0-9]{48}$/, message.channelNonce))
                return fail("unexpected-runtime-broker-reply");
            channelNonce = message.channelNonce;
            online = true;
            sender.bindChannel(channelNonce);
            socket.setTimeout(0);
            socket.unref();
            resolveReady();
            sender.resume();
        }
        if (bufferByteLength(input) > 65536)
            fail("runtime-broker-frame-too-large");
    });
    process.once("exit", () => {
        exiting = true;
        if (prepared && channelNonce && !seal)
            try {
                seal = sender.sealNow({
                    nonce: prepared.nonce,
                    nestedCoverage: nestedCoverage(),
                });
                seal = addInvalidReplies(seal, invalidReplies);
                socket.write(stringifyAuditData(seal) + "\n");
            }
            catch {
                // 同步 process.exit 无法证明最后一次 socket 写入已到达宿主。
            }
        sender.dispose();
    });
    return {
        ready,
        /** 提交带运行时身份的事件。 */
        emit(event) {
            sender.offer(event, event.action === "deny" || event.action === "restart");
        },
    };
}
//# sourceMappingURL=socket.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("runtime/socket.ts", { connectSocket })
