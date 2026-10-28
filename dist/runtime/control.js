import { createHmac, timingSafeEqual } from "node:crypto";
import { apply, error, numberIsInteger, objectDescriptor, objectFreeze, objectPrototype, objectSymbols, } from "../protect/intrinsics.js";
import { seal } from "../protect/objects.js";
import { M } from "../shared/messages.js";
const equal = timingSafeEqual;
const charCodeAt = String.prototype.charCodeAt;
const construct = Reflect.construct;
const Bytes = Uint8Array;
/** 提前固定 HMAC 的底层依赖；签名时不再经过可修改的 JS 构造链。 */
function captureHmac() {
    const probe = createHmac("sha256", "guard-control-probe");
    const symbols = objectSymbols(probe);
    for (let index = 0; index < symbols.length; index++) {
        const handle = objectDescriptor(probe, symbols[index])?.value;
        if (!handle || typeof handle !== "object")
            continue;
        const prototype = objectPrototype(handle);
        if (!prototype)
            continue;
        const constructor = objectDescriptor(prototype, "constructor")?.value;
        const init = objectDescriptor(prototype, "init")?.value;
        const update = objectDescriptor(prototype, "update")?.value;
        const digest = objectDescriptor(prototype, "digest")?.value;
        if (typeof constructor !== "function" ||
            typeof init !== "function" ||
            typeof update !== "function" ||
            typeof digest !== "function" ||
            objectDescriptor(constructor, "prototype")?.value !== prototype)
            continue;
        seal(prototype, "init", init, "control.hmac.init");
        seal(prototype, "update", update, "control.hmac.update");
        seal(prototype, "digest", digest, "control.hmac.digest");
        objectFreeze(prototype);
        objectFreeze(constructor);
        return { constructor, init, update, digest };
    }
    throw error(M.runtime.hmacUnsupported);
}
const hmac = captureHmac();
/** 把 latin1 字符串转为字节。 */
function bytes(value) {
    const result = new Bytes(value.length);
    for (let index = 0; index < value.length; index++)
        result[index] = apply(charCodeAt, value, [index]);
    return result;
}
/** 判断是否为需要签名的控制消息类型。 */
export function isControlType(value) {
    return (value === "restart-request" ||
        value === "stop-request" ||
        value === "update-request" ||
        value === "update-force-request" ||
        value === "rollback-request" ||
        value === "login-link-request" ||
        value === "preload-ready" ||
        value === "worker-online");
}
/** 判断为正安全整数。 */
function positiveInteger(value) {
    return (typeof value === "number" && numberIsInteger(value) && value > 0 && value <= 9007199254740991);
}
/** 判断为 64 位十六进制小写字符串。 */
function hex(value) {
    if (typeof value !== "string" || value.length !== 64)
        return false;
    for (let index = 0; index < value.length; index++) {
        const code = apply(charCodeAt, value, [index]);
        if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102)))
            return false;
    }
    return true;
}
/** 校验控制密钥、代次与 PID。 */
function checkIdentity(key, generation, pid) {
    if (!hex(key) || !positiveInteger(generation) || !positiveInteger(pid))
        throw error(M.runtime.controlIdentity);
}
/** 仅认证控制类型和实例身份；reason 等附加信息不能用于授权。 */
function createSignature(key) {
    const secret = bytes(key);
    const handle = construct(hmac.constructor, []);
    return frame => {
        apply(hmac.init, handle, ["sha256", secret]);
        if (!apply(hmac.update, handle, [
            `guard-control-v1\n${frame.type}\n${frame.generation}\n${frame.pid}\n${frame.sequence}`,
        ]))
            throw error(M.runtime.controlAuthFailed);
        return apply(hmac.digest, handle, ["hex"]);
    };
}
/** 每代实例使用独立密钥；不与会出现在审计帧中的 nonce 共用。 */
export function createControlSigner(key, generation, pid) {
    checkIdentity(key, generation, pid);
    const signature = createSignature(key);
    let sequence = 0;
    return type => {
        if (!isControlType(type) || !positiveInteger(sequence + 1))
            throw error(M.runtime.controlSequence);
        const frame = { type, generation, pid, sequence: ++sequence };
        return { ...frame, signature: signature(frame) };
    };
}
/** 只读取自有数据属性，不触发 getter。 */
function field(value, key) {
    const descriptor = objectDescriptor(value, key);
    return descriptor && objectDescriptor(descriptor, "value")?.value;
}
/** 宿主只接受本代、正确身份且未消费过的控制帧。 */
export function createControlVerifier(key, generation, pid) {
    checkIdentity(key, generation, pid);
    const signature = createSignature(key);
    let sequence = 0;
    return raw => {
        try {
            if (!raw || typeof raw !== "object")
                return false;
            const type = field(raw, "type");
            const next = field(raw, "sequence");
            const supplied = field(raw, "signature");
            if (!isControlType(type) ||
                field(raw, "generation") !== generation ||
                field(raw, "pid") !== pid ||
                !positiveInteger(next) ||
                next <= sequence ||
                !hex(supplied))
                return false;
            const expected = signature({ type, generation, pid, sequence: next });
            if (!equal(bytes(supplied), bytes(expected)))
                return false;
            sequence = next;
            return true;
        }
        catch {
            return false;
        }
    };
}
//# sourceMappingURL=control.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("runtime/control.ts", { isControlType, createControlSigner, createControlVerifier })
