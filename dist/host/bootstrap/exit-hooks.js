import { performance } from "node:perf_hooks";
import { M } from "../../shared/messages.js";
/** 取得核心的退出钩子，不存在时返回 undefined。 */
export function resolveExitHook(bot) {
    const handler = bot.exitEvent;
    if (typeof handler === "function")
        return (reason, budget) => handler.call(bot, reason, budget);
    const rawListeners = bot.rawListeners;
    if (typeof rawListeners !== "function")
        return undefined;
    let preparation;
    return (reason, budget) => (preparation ??= (async () => {
        if (!Number.isFinite(budget) || budget <= 0)
            throw new Error(M.host.exitHooksTimeoutValue);
        const deadline = performance.now() + budget;
        let timer;
        try {
            // 调用原始包装器，保留 once 的移除语义；不能调用会结束进程的 Bot.exit。
            const tasks = rawListeners
                .call(bot, "exit")
                .map(listener => Promise.resolve().then(() => listener.call(bot, reason)));
            await Promise.race([
                Promise.allSettled(tasks).then(results => {
                    if (performance.now() >= deadline)
                        throw new Error(M.host.exitHooksTimeout);
                    const failures = results
                        .filter(result => result.status === "rejected")
                        .map(result => result.reason);
                    if (failures.length)
                        throw new AggregateError(failures, M.host.exitHooksFailed);
                }),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(M.host.exitHooksTimeout)), budget);
                }),
            ]);
        }
        finally {
            clearTimeout(timer);
        }
    })());
}
/** 返回缺少退出钩子时的说明。 */
export function describeMissingExitHook() {
    return M.host.noExitHook;
}
//# sourceMappingURL=exit-hooks.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../../protect/objects.js"
__guardRegisterExports("host/bootstrap/exit-hooks.ts", { resolveExitHook, describeMissingExitHook })
