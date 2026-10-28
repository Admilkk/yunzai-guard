import { Worker } from "node:worker_threads";
// 在旧监控包装前保存引用；这是可信引擎适配器，不是业务 Node Worker。
const EngineWorker = Worker;
export class SandboxExecutor {
    #workers = new Set();
    #closed = false;
    /** 在独立 Worker 中执行受限脚本，超时或违规时终止。 */
    async execute(plugin, event, settings) {
        if (this.#closed || this.#workers.size >= 2)
            return { ok: false, code: "executor-unavailable" };
        if (plugin.source.length > 65536)
            return { ok: false, code: "source-too-large" };
        let worker;
        try {
            worker = new EngineWorker(new URL("./worker.js", import.meta.url), {
                workerData: { plugin, event, settings },
                env: {},
                execArgv: process.platform === "win32" ? ["--preserve-symlinks", "--preserve-symlinks-main"] : [],
                argv: [],
                resourceLimits: {
                    maxOldGenerationSizeMb: Math.max(16, plugin.memoryMiB),
                    maxYoungGenerationSizeMb: 8,
                    stackSizeMb: 2,
                },
                stdout: true,
                stderr: true,
            });
        }
        catch {
            return { ok: false, code: "engine-unavailable" };
        }
        this.#workers.add(worker);
        // 丢弃引擎诊断，不将插件可能控制的输出直接写入日志。
        worker.stdout?.resume();
        worker.stderr?.resume();
        return new Promise(resolve => {
            let done = false;
            let started = false;
            const finish = (result) => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                void worker.terminate().finally(() => {
                    this.#workers.delete(worker);
                    resolve(this.#closed ? { ok: false, code: "executor-closed" } : result);
                });
            };
            // 模块加载及可信 VM 引导准备使用独立的有界预算。
            // 宿主繁忙时也不能占用配置给插件执行的期限。
            let timer = setTimeout(() => finish({ ok: false, code: "engine-startup-timeout" }), 10000);
            worker.once("error", (error) => finish({
                ok: false,
                code: [
                    "EPERM",
                    "EACCES",
                    "ENOENT",
                    "ERR_MODULE_NOT_FOUND",
                    "ERR_WORKER_OUT_OF_MEMORY",
                ].includes(error.code ?? "")
                    ? `engine-${error.code}`
                    : "engine-failure",
            }));
            worker.once("exit", () => finish({ ok: false, code: "engine-exited" }));
            worker.on("message", (message) => {
                if (done)
                    return;
                if (message &&
                    typeof message === "object" &&
                    "type" in message &&
                    message.type === "sandbox-ready") {
                    if (started) {
                        finish({ ok: false, code: "engine-protocol" });
                        return;
                    }
                    started = true;
                    clearTimeout(timer);
                    timer = setTimeout(() => finish({ ok: false, code: "hard-timeout" }), (plugin.timeoutMs ?? settings.timeoutMs) + 2000);
                    return;
                }
                if (!message ||
                    typeof message !== "object" ||
                    !("ok" in message) ||
                    typeof message.ok !== "boolean") {
                    finish({ ok: false, code: "engine-protocol" });
                    return;
                }
                // 初始化可在就绪前失败，但接受插件成功结果前必须已经就绪。
                if (message.ok && !started) {
                    finish({ ok: false, code: "engine-protocol" });
                    return;
                }
                finish(message);
            });
        });
    }
    /** 关闭执行器并终止 Worker。 */
    async close() {
        this.#closed = true;
        await Promise.all([...this.#workers].map(worker => worker.terminate()));
    }
}
//# sourceMappingURL=executor.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("plugin-sandbox/executor.ts", { SandboxExecutor })
