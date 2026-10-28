import fs from "node:fs";
import { GuardPanel } from "./server.js";
let panel;
/** 写入面板日志，失败时忽略。 */
function logLine(message) {
    try {
        console.error(message);
    }
    catch {
        // 控制台句柄不可写（例如 detached 子进程继承了失效的 ConPTY）时忽略，
        // 面板仍可通过 HTTP 访问，验证码会同时落盘。
    }
}
/** 读取插件版本号。 */
function readVersion() {
    try {
        const packageFile = new URL("../../package.json", import.meta.url);
        const parsed = JSON.parse(fs.readFileSync(packageFile, "utf8"));
        return typeof parsed.version === "string" ? parsed.version : "unknown";
    }
    catch {
        return "unknown";
    }
}
/** 面板与宿主同生命周期：宿主退出后端口随之释放，不会留下孤儿服务。 */
export async function startPanel(options) {
    if (panel)
        return;
    let instance;
    try {
        instance = new GuardPanel({ ...options, version: readVersion(), log: logLine });
    }
    catch (error) {
        // 面板配置损坏不能影响宿主接管业务进程。
        logLine(`[Yunzai Guard] 控制台初始化失败：${error.message}`);
        return;
    }
    panel = instance;
    try {
        await instance.start();
    }
    catch (error) {
        panel = undefined;
        logLine(`[Yunzai Guard] 控制台启动失败：${error.message}`);
    }
}
/** 停止面板服务。 */
export async function stopPanel() {
    const instance = panel;
    panel = undefined;
    await instance?.stop();
}
//# sourceMappingURL=index.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("web/index.ts", { startPanel, stopPanel })
