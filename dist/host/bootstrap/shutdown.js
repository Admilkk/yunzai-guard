import { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { resolveExitHook } from "./exit-hooks.js";
import { M } from "../../shared/messages.js";
/** 在限定时间内执行一个关闭阶段，超时抛错。 */
async function bounded(work, timeout, stage) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(work),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(M.host.stageTimeout(stage))), timeout);
            }),
        ]);
    }
    finally {
        clearTimeout(timer);
    }
}
/** 退出前关闭原始或受控核心资源，绝不停止外部 Redis。 */
export async function shutdownBootstrapResources(bot, redisClient, timeout, currentRedisClient = () => redisClient) {
    const deadline = performance.now() + timeout;
    const remaining = () => Math.max(1, deadline - performance.now());
    const client = redisClient;
    const originalProcess = client?.process;
    const ownedRedis = originalProcess instanceof ChildProcess ? originalProcess : undefined;
    const assertOriginalRedis = () => {
        if (currentRedisClient() !== redisClient)
            throw new Error(M.host.cleanupRedisClient);
        if (client?.process !== originalProcess)
            throw new Error(M.host.cleanupRedisService);
    };
    const exited = () => !ownedRedis || ownedRedis.exitCode !== null || ownedRedis.signalCode !== null;
    let onExit;
    const redisStopped = new Promise(resolve => {
        if (exited())
            resolve();
        else {
            onExit = resolve;
            ownedRedis.once("exit", onExit);
        }
    });
    let hookError;
    let hookFailed = false;
    let clientErrorHandler;
    let completed = false;
    const clientErrors = [];
    const stopClientReconnect = () => {
        try {
            if (client?.isOpen && typeof client.disconnect === "function")
                void Promise.resolve(client.disconnect()).catch(error => clientErrors.push(error));
        }
        catch (error) {
            clientErrors.push(error);
        }
    };
    try {
        // 即使业务退出钩子卡住，也要为核心自有服务预留清理时间。
        const hookBudget = Math.max(1, Math.floor(timeout / 2));
        const exitHook = resolveExitHook(bot);
        if (exitHook) {
            try {
                await bounded(() => exitHook("restart", hookBudget), hookBudget, M.host.stageExitHooks);
            }
            catch (error) {
                hookFailed = true;
                hookError = error;
            }
        }
        await bounded(async () => {
            assertOriginalRedis();
            if (client) {
                if (typeof client.quit !== "function" ||
                    typeof client.disconnect !== "function" ||
                    typeof client.on !== "function" ||
                    typeof client.off !== "function" ||
                    typeof client.listeners !== "function")
                    throw new Error(M.host.redisNoClose);
                // 保留其他业务监听器。核心的 once(error) 回调可能重启服务，
                // SDK 也可能在发出 error 后重新连接。
                clientErrorHandler = error => {
                    clientErrors.push(error);
                    stopClientReconnect();
                };
                client.on("error", clientErrorHandler);
                const reconnect = client.class?.onerror;
                if (typeof reconnect === "function")
                    for (const listener of client.listeners("error"))
                        if (listener === reconnect)
                            client.off("error", reconnect);
                if (ownedRedis) {
                    if (typeof client.save !== "function")
                        throw new Error(M.host.redisNoPersistence);
                    await client.save();
                }
                // QUIT 仅关闭当前连接，不会停止外部服务。
                await client.quit();
            }
            assertOriginalRedis();
            if (ownedRedis) {
                // 核心会捕获对已关闭客户端重复执行 SAVE 的异常；
                // 实际停止服务仍由原始 redisExit 负责。
                await bot.redisExit?.();
                await redisStopped;
            }
            if (clientErrors.length)
                throw clientErrors[0];
        }, remaining(), M.host.stageRedisCleanup);
        if (hookFailed)
            throw hookError;
        completed = true;
    }
    catch (error) {
        stopClientReconnect();
        // 服务退出未确认时交接必须失败，避免新旧服务并行。尽力发送信号时，
        // 也只能操作原始 ChildProcess 句柄。
        if (ownedRedis && !exited())
            ownedRedis.kill("SIGTERM");
        throw error;
    }
    finally {
        if (onExit)
            ownedRedis.removeListener("exit", onExit);
        // 交接失败后旧进程将退出，不恢复其重连钩子，
        // 也不让退出期间的最后一个错误成为未处理异常。
        if (completed && clientErrorHandler)
            client.off("error", clientErrorHandler);
    }
}
//# sourceMappingURL=shutdown.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../../protect/objects.js"
__guardRegisterExports("host/bootstrap/shutdown.ts", { shutdownBootstrapResources })
