import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeReady, prepareNode } from "./node.js";
import { prepareBubblewrap } from "./linux-bwrap.js";
import { compileWindowsSandbox } from "../sandbox/windows.js";
import { M } from "../shared/messages.js";
/** 只准备当前模式确实需要的组件，不安装系统服务或提升权限。 */
export async function prepareDependencies(settings) {
    const repository = fileURLToPath(new URL("../../", import.meta.url));
    const node = await prepareNode(repository);
    const result = {
        platform: process.platform,
        node,
        privateOfficialNode: node !== process.execPath,
        currentNodeQualified: process.platform !== "win32" || nodeReady(process.execPath),
    };
    if (process.platform === "win32") {
        const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
        if (!fs.existsSync(powershell))
            throw new Error(M.dependencies.powershellMissing);
        result.powershell = powershell;
    }
    const sandbox = settings.isolationMode === "os-sandbox" ||
        settings.pluginSandbox.native.plugins.some(item => item.enabled);
    const network = settings.isolationMode === "os-sandbox"
        ? settings.sandbox.network
        : settings.pluginSandbox.native.plugins.some(item => item.enabled && item.network === "none")
            ? "none"
            : "host";
    if (sandbox)
        result.sandbox =
            process.platform === "linux"
                ? prepareBubblewrap(repository, settings.sandbox.bwrapPath, network)
                : process.platform === "win32"
                    ? compileWindowsSandbox()
                    : (() => {
                        throw new Error(M.dependencies.sandboxUnsupported);
                    })();
    return result;
}
//# sourceMappingURL=check.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("dependencies/check.ts", { prepareDependencies })
