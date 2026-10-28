import { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { describeMissingExitHook, resolveExitHook } from "./exit-hooks.js";
import { M } from "../../shared/messages.js";
/** 原回调仍可能执行时，仅准备持久化，不提前关闭资源。 */
export function createBootstrapExitPlan(bot, redisClient, currentClient) {
    const client = redisClient;
    const originalProcess = client?.process;
    const ownedRedis = originalProcess instanceof ChildProcess ? originalProcess : undefined;
    const redisPid = ownedRedis?.pid ?? null;
    // 此回调必须保持同步；接管宿主会独立确认旧服务实际退出，
    // 之后才启动替代核心。
    process.once("exit", () => {
        if (!ownedRedis || ownedRedis.exitCode !== null || ownedRedis.signalCode !== null)
            return;
        try {
            ownedRedis.kill("SIGTERM");
        }
        catch {
            // 进程退出时无法等待恢复，只能操作已捕获的原始句柄。
        }
    });
    if (ownedRedis &&
        (typeof redisPid !== "number" || !Number.isSafeInteger(redisPid) || redisPid <= 1))
        throw new Error(M.host.redisPid);
    const assertCurrent = () => {
        if (currentClient() !== redisClient)
            throw new Error(M.host.redisClientChanged);
        if (client?.process !== originalProcess)
            throw new Error(M.host.redisServiceChanged);
        if (ownedRedis && ownedRedis.pid !== redisPid)
            throw new Error(M.host.redisPidChanged);
    };
    let preparation;
    const prepare = async (timeout) => {
        if (!Number.isFinite(timeout) || timeout <= 0)
            throw new Error(M.host.exitPrepareTimeoutValue);
        const deadline = performance.now() + timeout;
        const remaining = (stage) => {
            const budget = deadline - performance.now();
            if (budget <= 0)
                throw new Error(M.host.stageTimeout(stage));
            return budget;
        };
        const bounded = async (stage, operation) => {
            const budget = remaining(stage);
            let timer;
            try {
                await Promise.race([
                    Promise.resolve().then(() => operation(remaining(stage))),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error(M.host.stageTimeout(stage))), budget);
                    }),
                ]);
                remaining(stage);
            }
            finally {
                clearTimeout(timer);
            }
        };
        assertCurrent();
        const exitHook = resolveExitHook(bot);
        if (exitHook)
            await bounded(M.host.stageExitHooks, budget => exitHook("restart", budget));
        else
            console.error(describeMissingExitHook());
        assertCurrent();
        if (ownedRedis) {
            if (typeof client?.save !== "function")
                throw new Error(M.host.redisNoPersistence);
            await bounded(M.host.stageRedisSave, () => client.save());
        }
        assertCurrent();
    };
    return Object.freeze({
        redisPid,
        assertCurrent,
        /** 准备退出；计划只执行一次，不重复调用退出钩子。 */
        prepare(timeout) {
            return (preparation ??= prepare(timeout));
        },
    });
}
//# sourceMappingURL=exit-plan.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../../protect/objects.js"
__guardRegisterExports("host/bootstrap/exit-plan.ts", { createBootstrapExitPlan })
