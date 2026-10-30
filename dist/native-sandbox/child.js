import { ensureWorkerTransport } from "../runtime/worker-transport.js";
import { installSandboxResolution } from "../sandbox/resolution.js";
import { NativeGuest } from "./guest.js";
import { ProtocolError, fromDto, maxFrameBytes, toDto } from "./protocol.js";
import { validateAdapterCall } from "./adapter/protocol.js";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { installNativeBehavior } from "./behavior.js";
import { M } from "../shared/messages.js";
await ensureWorkerTransport();
installSandboxResolution(process.env.YUNZAI_GUARD_RUNTIME_MANIFEST);
const rawSend = process.send.bind(process);
const rawExit = process.exit.bind(process);
const pending = new Map();
let serviceSequence = 0;
let activeRequests = 0;
let queue = Promise.resolve();
/** 把错误转为有界的错误码与消息。 */
function fail(error) {
    return {
        code: error instanceof ProtocolError ? error.code : "PLUGIN_ERROR",
        message: (error instanceof Error ? error.message : String(error)).slice(0, 8000),
    };
}
/** 向父进程发送消息，失败时退出。 */
function send(message) {
    const frame = toDto(message);
    if (Buffer.byteLength(JSON.stringify(frame)) > maxFrameBytes)
        throw new ProtocolError("FRAME_TOO_LARGE", M.nativeSandbox.frameTooLarge);
    if (!process.connected)
        throw new ProtocolError("PARENT_DISCONNECTED", M.nativeSandbox.parentGone);
    rawSend(frame, error => {
        if (error)
            rawExit(1);
    });
}
/** 报告致命错误后退出；只保留有界错误信息，不把原始输出传给高权限父进程，之后不再执行插件。 */
const fatal = (error) => {
    try {
        rawSend({ type: "native-fatal", error: fail(error) }, () => rawExit(1));
        setTimeout(() => rawExit(1), 250).unref();
    }
    catch {
        rawExit(1);
    }
};
process.once("uncaughtException", fatal);
process.once("unhandledRejection", fatal);
const policyPath = process.env.YUNZAI_GUARD_RUNTIME_MANIFEST;
let behavior;
if (policyPath) {
    const bytes = fs.readFileSync(policyPath);
    if (bytes.length > 8 * 1024 * 1024)
        throw new Error(M.nativeSandbox.manifestTooLarge);
    const policy = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).nativeBehavior;
    if (policy !== undefined) {
        if (!policy ||
            typeof policy !== "object" ||
            Array.isArray(policy) ||
            typeof policy.pluginId !== "string")
            throw new Error(M.nativeSandbox.behaviorPolicy);
        behavior = installNativeBehavior({
            pluginId: policy.pluginId,
            identity: { id: randomUUID(), generation: 1 },
            settings: policy.settings,
            resolutionManifestPath: policyPath,
            emit: event => send({ type: "native-behavior", event }),
        });
        await behavior.ready;
    }
}
const guest = new NativeGuest({
    send,
    /** 向父进程请求宿主能力。 */
    service(service, method, args, requestId) {
        if (pending.size >= 64)
            return Promise.reject(new ProtocolError("SERVICE_LIMIT", M.nativeSandbox.servicePending));
        const id = String(++serviceSequence);
        const timeoutMs = service === "event" && method === "reply" ? 90000 : 10000;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new ProtocolError("SERVICE_TIMEOUT", M.nativeSandbox.serviceTimeout));
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            try {
                send({
                    type: "native-service",
                    id,
                    service,
                    method,
                    args,
                    ...(requestId ? { requestId } : {}),
                });
            }
            catch (error) {
                clearTimeout(timer);
                pending.delete(id);
                reject(error);
            }
        });
    },
});
process.once("disconnect", () => {
    for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new ProtocolError("PARENT_DISCONNECTED", M.nativeSandbox.parentGone));
    }
    pending.clear();
    rawExit(0);
});
process.on("message", (input) => {
    let message;
    try {
        if (Buffer.byteLength(JSON.stringify(input)) > maxFrameBytes)
            throw new ProtocolError("FRAME_TOO_LARGE", M.nativeSandbox.frameTooLarge);
        if (!input || typeof input !== "object" || Array.isArray(input))
            throw new ProtocolError("INVALID_MESSAGE", M.nativeSandbox.expectedObject);
        message = input;
        if (message.type === "native-service-result") {
            if (typeof message.id !== "string")
                return;
            const item = pending.get(message.id);
            if (!item)
                return;
            pending.delete(message.id);
            clearTimeout(item.timer);
            if (message.ok === true)
                item.resolve(fromDto(message.value));
            else {
                const error = message.error;
                item.reject(new ProtocolError(String(error?.code ?? "SERVICE_DENIED"), String(error?.message ?? M.nativeSandbox.serviceDenied)));
            }
            return;
        }
        if (typeof message.requestId !== "string" ||
            !message.requestId ||
            message.requestId.length > 128)
            throw new ProtocolError("INVALID_REQUEST", M.nativeSandbox.requestId);
        if (activeRequests >= 64)
            throw new ProtocolError("REQUEST_LIMIT", M.nativeSandbox.requestsPending);
        activeRequests++;
        const operation = queue
            .then(async () => {
            try {
                let value;
                if (message.botState !== undefined)
                    guest.updateBotSnapshot(message.botState);
                if (message.type === "native-load") {
                    if (![message.root, message.pluginRoot, message.entry].every(value => typeof value === "string"))
                        throw new ProtocolError("INVALID_REQUEST", M.nativeSandbox.loadArgs);
                    if (message.hookAction !== undefined &&
                        !["audit", "deny", "restart"].includes(String(message.hookAction)))
                        throw new ProtocolError("INVALID_REQUEST", M.nativeSandbox.hookAction);
                    if (message.adapters !== undefined && typeof message.adapters !== "boolean")
                        throw new ProtocolError("INVALID_REQUEST", M.nativeSandbox.adapterCapability);
                    if (message.botEventsSessionId !== undefined &&
                        typeof message.botEventsSessionId !== "string")
                        throw new ProtocolError("INVALID_REQUEST", M.nativeSandbox.botEventSession);
                    value = await guest.load(message.requestId, message.root, message.pluginRoot, message.entry, message.hookAction, message.adapters === true, message.botEventsSessionId);
                }
                else if (message.type === "native-call") {
                    if (typeof message.classId !== "string" ||
                        typeof message.method !== "string" ||
                        (message.args !== undefined && !Array.isArray(message.args)) ||
                        (message.eventArgs !== undefined && !Array.isArray(message.eventArgs)) ||
                        (message.handlerReject !== undefined && typeof message.handlerReject !== "boolean") ||
                        (message.contextHandle !== undefined && typeof message.contextHandle !== "string") ||
                        (message.instanceId !== undefined &&
                            (typeof message.instanceId !== "string" ||
                                !/^[0-9a-f-]{36}$/.test(message.instanceId))) ||
                        (message.ruleIndex !== undefined &&
                            (!Number.isInteger(message.ruleIndex) ||
                                message.ruleIndex < 0 ||
                                message.ruleIndex > 255)))
                        throw new ProtocolError("INVALID_REQUEST", M.nativeSandbox.callArgs);
                    value = await guest.call(message.requestId, message.classId, message.method, message.event, message.args, message.eventArgs, message.handlerReject === true, message.contextHandle, message.instanceId, message.ruleIndex);
                }
                else if (message.type === "native-release-instances") {
                    if (!Array.isArray(message.instances) ||
                        message.instances.length > 16 ||
                        message.instances.some(item => !item ||
                            typeof item !== "object" ||
                            typeof item.classId !== "string" ||
                            item.classId.length > 512 ||
                            typeof item.instanceId !== "string" ||
                            !/^[0-9a-f-]{36}$/.test(item.instanceId)))
                        throw new ProtocolError("INVALID_REQUEST", M.nativeSandbox.callArgs);
                    for (const item of message.instances)
                        guest.releaseInstance(item.classId, item.instanceId);
                    value = null;
                }
                else if (message.type === "native-context") {
                    if (typeof message.classId !== "string" || typeof message.isGroup !== "boolean")
                        throw new ProtocolError("INVALID_REQUEST", M.nativeSandbox.contextLookup);
                    value = await guest.context(message.requestId, message.classId, message.event, message.isGroup);
                }
                else if (message.type === "native-match") {
                    if (typeof message.classId !== "string" ||
                        typeof message.ruleIndex !== "number" ||
                        typeof message.text !== "string")
                        throw new ProtocolError("INVALID_REQUEST", M.nativeSandbox.matchArgs);
                    value = guest.match(message.classId, message.ruleIndex, message.text);
                }
                else if (message.type === "native-callback") {
                    if (typeof message.classId !== "string" ||
                        typeof message.handle !== "string" ||
                        (message.args !== undefined && !Array.isArray(message.args)) ||
                        (message.eventArgs !== undefined && !Array.isArray(message.eventArgs)) ||
                        (message.handlerReject !== undefined && typeof message.handlerReject !== "boolean"))
                        throw new ProtocolError("INVALID_REQUEST", M.nativeSandbox.callbackArgs);
                    value = await guest.callback(message.requestId, message.classId, message.handle, message.event, message.args, message.eventArgs, message.handlerReject === true);
                }
                else if (message.type === "native-bot-event") {
                    if (typeof message.handle !== "string" ||
                        !Array.isArray(message.args) ||
                        typeof message.eventReply !== "boolean")
                        throw new ProtocolError("INVALID_REQUEST", M.nativeSandbox.botEventDelivery);
                    value = await guest.botEvent(message.requestId, message.handle, message.args, message.eventReply);
                }
                else if (message.type === "native-adapter-call") {
                    value = await guest.adapterCall(message.requestId, validateAdapterCall(message.call));
                }
                else if (message.type === "native-dispose") {
                    try {
                        value = await guest.dispose(message.requestId);
                    }
                    finally {
                        behavior?.dispose();
                    }
                }
                else
                    throw new ProtocolError("INVALID_REQUEST", M.nativeSandbox.requestType);
                send({ type: "native-result", requestId: message.requestId, ok: true, value });
            }
            catch (error) {
                send({
                    type: "native-result",
                    requestId: message.requestId,
                    ok: false,
                    error: fail(error),
                });
            }
            finally {
                activeRequests--;
            }
        })
            .catch(() => rawExit(1));
        // 导入和生命周期转换保持有序；消息处理可能等待后续
        // 消息，例如原 awaitContext API，因此普通调用不能阻塞后续消息。
        if (message.type === "native-load" || message.type === "native-dispose")
            queue = operation;
    }
    catch (error) {
        const requestId = input?.requestId;
        if (typeof requestId === "string" && requestId.length <= 128)
            try {
                send({ type: "native-result", requestId, ok: false, error: fail(error) });
            }
            catch {
                rawExit(1);
            }
        else
            rawExit(1);
    }
});
send({ type: "native-ready", pid: process.pid });
//# sourceMappingURL=child.js.map