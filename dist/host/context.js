import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadSettings, prepareSettings } from "../config/index.js";
import { root, stateDir, projectId } from "../shared/identity.js";
import { M } from "../shared/messages.js";
// 宿主启动状态：导入即创建状态目录并读取配置，只供 supervisor 使用。
export { root, stateDir, projectId };
fs.mkdirSync(stateDir, { recursive: true });
for (const notice of prepareSettings(stateDir))
    console.error(notice);
export const settings = loadSettings(stateDir);
// 带身份验证的控制端点与项目单例锁相互独立。
export const controlPort = settings.controlPort ?? 0;
export const controlPath = path.join(stateDir, "control.json");
export { setTimeout as sleep } from "node:timers/promises";
/** 轮询条件直到为真，超时抛错。 */
export async function until(predicate, ms = 15000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const result = await predicate();
        if (result)
            return result;
        await sleep(25);
    }
    throw new Error(M.host.deadline);
}
//# sourceMappingURL=context.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("host/context.ts", { root, stateDir, projectId, settings, controlPort, controlPath, until })
