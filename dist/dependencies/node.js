import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createDirectory, verifyFile } from "./files.js";
import { M } from "../shared/messages.js";
export const windowsNode = Object.freeze({
    version: "24.22.1",
    sha256: "d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5",
    url: "https://nodejs.org/dist/v24.22.1/win-x64/node.exe",
});
const preparing = new Map();
const folder = `node-v${windowsNode.version}-win-x64`;
/** 返回 Guard 缓存目录中的固定 Node 路径。 */
const cacheFile = (root) => path.join(root, ".cache/dependencies", `node-${windowsNode.version}-win-x64`, "node.exe");
/** 发布包随附的固定运行时，位于插件根目录 runtime/ 下。 */
export const bundledNode = (root) => path.join(root, "runtime", folder, "node.exe");
/** 只接受固定摘要，不执行下载内容来判断版本。 */
export function nodeReady(file) {
    try {
        verifyFile(fs.realpathSync(file), windowsNode.sha256);
        return true;
    }
    catch {
        return false;
    }
}
/** 下载并按固定摘要核验；也供发布打包脚本写入随附运行时。 */
export async function downloadNode(target) {
    const temporary = path.join(path.dirname(target), `download-${randomUUID()}.exe`);
    try {
        await new Promise((resolve, reject) => {
            const request = https.get(windowsNode.url, { timeout: 120000 }, response => {
                if (response.statusCode !== 200) {
                    response.resume();
                    reject(new Error(M.dependencies.nodeHttp(response.statusCode)));
                    return;
                }
                let received = 0;
                const limit = new Transform({
                    /** 累计下载字节数，超过上限时中止。 */
                    transform(chunk, _encoding, done) {
                        received += chunk.length;
                        done(received > 128 * 1024 * 1024 ? new Error(M.dependencies.nodeTooLarge) : null, chunk);
                    },
                });
                void pipeline(response, limit, fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 })).then(resolve, reject);
            });
            const deadline = setTimeout(() => request.destroy(new Error(M.dependencies.nodeTimeout)), 120000);
            deadline.unref();
            request.once("close", () => clearTimeout(deadline));
            request.on("timeout", () => request.destroy(new Error(M.dependencies.nodeTimeout)));
            request.on("error", reject);
        });
        verifyFile(temporary, windowsNode.sha256);
        fs.renameSync(temporary, target);
        verifyFile(target, windowsNode.sha256);
    }
    finally {
        fs.rmSync(temporary, { force: true });
    }
}
/** 仅准备 Guard 自己的宿主运行时，不更换系统 Node、PATH 或 PM2 daemon。 */
export async function prepareNode(root) {
    if (process.platform !== "win32")
        return process.execPath;
    if (process.arch !== "x64")
        throw new Error(M.dependencies.nodeWindowsOnly);
    if (nodeReady(process.execPath))
        return process.execPath;
    const repository = fs.realpathSync(root);
    const bundled = bundledNode(repository);
    if (fs.existsSync(bundled))
        return verifyFile(bundled, windowsNode.sha256);
    const target = cacheFile(repository);
    if (fs.existsSync(target))
        return verifyFile(target, windowsNode.sha256);
    let pending = preparing.get(target);
    if (!pending) {
        pending = (async () => {
            createDirectory(path.dirname(target));
            await downloadNode(target);
            return target;
        })();
        preparing.set(target, pending);
        void pending.finally(() => preparing.delete(target)).catch(() => { });
    }
    return pending;
}
//# sourceMappingURL=node.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("dependencies/node.ts", { windowsNode, bundledNode, nodeReady, downloadNode, prepareNode })
