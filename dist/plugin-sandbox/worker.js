import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { guestBootstrap } from "./guest-api.js";
const require = createRequire(import.meta.url);
const { plugin, event, settings } = workerData;
const actions = [];
const attempts = [];
let denied = false;
let bytes = 0;
let phase = "initializing";
let completion = "script-failed";
const timeoutMs = plugin.timeoutMs ?? settings.timeoutMs;
const memoryMiB = plugin.memoryMiB ?? settings.memoryMiB;
let deadline = Infinity;
let timeout;
/** 以结果码结束执行并通知父线程。 */
function finish(code) {
    if (phase === "closed")
        return;
    phase = "closed";
    const result = denied || code !== "ok"
        ? { ok: false, code: denied ? "capability-denied" : code }
        : { ok: true, actions };
    if (attempts.length)
        result.attempts = attempts;
    parentPort.postMessage(result);
    parentPort.close();
}
/** 标记违规并返回 false。 */
function fail() {
    denied = true;
    return false;
}
/** 不得转换、检查或序列化通过这些回调传入的插件对象。 */
function invoke(...args) {
    if (phase === "closing" || phase === "closed")
        return fail();
    if (performance.now() >= deadline)
        return fail();
    if (args.length < 2 || args.length > 3 || args.some(arg => typeof arg !== "string"))
        return fail();
    const [capability, text, file] = args;
    if (!plugin.capabilities.includes(capability) ||
        capability.length > 32 ||
        actions.length >= 16 ||
        text.length > (capability === "writeText" ? 16384 : 4096) ||
        (file !== undefined && file.length > 64) ||
        (capability === "writeText" ? file === undefined : file !== undefined))
        return fail();
    bytes += Buffer.byteLength(text, "utf8") + Buffer.byteLength(file ?? "", "utf8");
    if (bytes > 32768)
        return fail();
    actions.push({
        capability: capability,
        text,
        ...(file === undefined ? {} : { file }),
    });
    return true;
}
/** 检查脚本请求的能力是否获授权。 */
function attempt(operation, target) {
    if (phase === "closed" ||
        typeof operation !== "string" ||
        operation !== "sandbox.hook" ||
        typeof target !== "string" ||
        !target.length ||
        target.length > 256 ||
        attempts.length >= 32)
        return fail();
    attempts.push({ operation, target });
    return true;
}
/** 处理脚本完成：初始化阶段转入运行，否则结束。 */
function done(code) {
    if (phase === "initializing") {
        denied = true;
        return;
    }
    if (phase !== "running")
        return;
    if (code !== "ok" && code !== "script-failed") {
        denied = true;
        code = "script-failed";
    }
    completion = code;
    phase = "closing";
    // 已排队的插件微任务仍可能越权，微任务执行后须检查保留的违规状态。
    setImmediate(() => finish(performance.now() >= deadline ? "execution-timeout" : completion));
}
// 未完成的 Promise 保持存活，直到可信看门狗在期限内返回失败。
parentPort.once("close", () => clearTimeout(timeout));
try {
    const { VM } = require("../vendor/vm2/index.js");
    const vm = new VM({
        // 父进程启动插件看门狗前，仅运行可信引导代码。
        timeout: 10000,
        eval: false,
        wasm: false,
        allowAsync: true,
        // vm2 3.12.2 起已实现此选项，当前 .d.ts 尚未声明。
        ...{ bufferAllocLimit: memoryMiB * 1024 * 1024 },
        sandbox: { __guardInvoke: invoke, __guardAttempt: attempt, __guardDone: done },
    });
    vm.run(guestBootstrap(event, settings.plugins.map(item => item.id)), "guard-bootstrap.js");
    const { parse } = require("../vendor/node_modules/acorn");
    const { full } = require("../vendor/node_modules/acorn-walk");
    // 导入不属于可选授权；即使插件捕获错误，也在语法检查时拒绝。
    full(parse(plugin.source, { ecmaVersion: "latest", sourceType: "script" }), node => {
        if (node.type === "ImportExpression" || node.type === "ImportDeclaration")
            denied = true;
    });
    if (denied)
        finish("capability-denied");
    else {
        vm.timeout = timeoutMs;
        parentPort.postMessage({ type: "sandbox-ready" });
        deadline = performance.now() + timeoutMs;
        timeout = setTimeout(() => finish("execution-timeout"), timeoutMs);
        vm.run(`"use strict";\n${plugin.source}`, `${plugin.id}.js`);
        if (performance.now() >= deadline)
            finish("execution-timeout");
        else {
            phase = "running";
            vm.run("__guardRun(); void 0", "guard-dispatch.js");
        }
    }
}
catch {
    // 宿主不得检查插件错误、getter 或代理对象。
    finish(performance.now() >= deadline ? "execution-timeout" : "script-failed");
}
//# sourceMappingURL=worker.js.map