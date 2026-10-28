import { M } from "../../shared/messages.js";
/** 等待核心发出就绪信号。 */
export function waitForBootstrapReady(bot, timeout, signal) {
    return new Promise((resolve, reject) => {
        let timer;
        let settled = false;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            bot.off("online", check);
            signal?.removeEventListener("abort", abort);
            if (error)
                reject(error);
            else
                resolve();
        };
        const abort = () => finish(new Error(M.host.readyCancelled));
        const check = () => {
            try {
                const stat = bot.stat;
                if (stat?.online === 2)
                    finish();
            }
            catch (error) {
                finish(error);
            }
        };
        if (signal?.aborted) {
            abort();
            return;
        }
        timer = setTimeout(() => finish(new Error(M.host.coreTimeout)), timeout);
        signal?.addEventListener("abort", abort, { once: true });
        try {
            bot.on("online", check);
            // 订阅后复查状态，兼容已经就绪的核心。
            check();
        }
        catch (error) {
            finish(error);
        }
    });
}
//# sourceMappingURL=ready.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../../protect/objects.js"
__guardRegisterExports("host/bootstrap/ready.ts", { waitForBootstrapReady })
