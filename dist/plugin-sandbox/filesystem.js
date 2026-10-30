import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { M } from "../shared/messages.js";
import { sha256 } from "../shared/hash.js";
import { isOrdinaryFile } from "../shared/files.js";
/** 拒绝 reparse/symlink 路径分量；外层项目视为可信安装。 */
function directory(root, parts, create, allowMissing = false) {
    // AppContainer 启动前，宿主与身份模块已将 root 规范化。
    // 再次调用 realpath 会查询 AppContainer 无权访问的祖先路径。
    let current = path.resolve(root);
    const rootStat = fs.lstatSync(current);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        throw new Error(M.pluginSandbox.rootAlias);
    for (const [index, part] of parts.entries()) {
        current = path.join(current, part);
        if (create) {
            try {
                fs.mkdirSync(current, { mode: 0o700 });
            }
            catch (error) {
                if (error.code !== "EEXIST")
                    throw error;
            }
        }
        let stat;
        try {
            stat = fs.lstatSync(current);
        }
        catch (error) {
            if (allowMissing && error.code === "ENOENT")
                return path.join(current, ...parts.slice(index + 1));
            throw error;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error(M.pluginSandbox.directoryAlias);
    }
    return current;
}
/** 读取已启用受限脚本的源码。 */
export function loadSandboxSources(root, settings) {
    if (!settings.plugins.some(plugin => plugin.enabled))
        return [];
    const base = directory(root, ["data", "yunzai-guard", "scripts"], false);
    const sources = settings.plugins
        .filter(plugin => plugin.enabled)
        .map(plugin => {
        const file = path.join(base, `${plugin.id}.js`);
        const stat = fs.lstatSync(file);
        if (!isOrdinaryFile(stat, 65536))
            throw new Error(M.pluginSandbox.source(plugin.id));
        const bytes = fs.readFileSync(file);
        if (bytes.length > 65536)
            throw new Error(M.pluginSandbox.sourceTooLarge);
        const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return { ...plugin, source, sha256: sha256(bytes) };
    });
    if (Buffer.byteLength(JSON.stringify(sources)) > 32768)
        throw new Error(M.pluginSandbox.sourcesBudget);
    return sources;
}
/** 校验脚本文件名。 */
export function sandboxFilename(name) {
    if (typeof name !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name) ||
        name.includes("..") ||
        name.endsWith(".") ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name))
        throw new Error(M.pluginSandbox.fileName);
}
/** 解析受限脚本可写文件的目标路径，禁止越出插件目录。 */
export function sandboxWriteTarget(root, id, file, create = true) {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(id))
        throw new Error(M.pluginSandbox.pluginIdentity);
    sandboxFilename(file);
    const base = directory(root, ["data", "yunzai-guard-strict", id], create, !create);
    const target = path.join(base, file);
    try {
        const stat = fs.lstatSync(target);
        if (!isOrdinaryFile(stat))
            throw new Error(M.pluginSandbox.fileAlias);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    return target;
}
/** 为受限脚本写入文本文件。 */
export function writeSandboxText(root, id, file, text) {
    const target = sandboxWriteTarget(root, id, file);
    let count = 0, bytes = 0;
    for (const entry of fs.readdirSync(path.dirname(target))) {
        const existing = path.join(path.dirname(target), entry);
        const stat = fs.lstatSync(existing);
        if (!isOrdinaryFile(stat))
            throw new Error(M.pluginSandbox.storageAlias);
        if (entry !== file) {
            count++;
            bytes += stat.size;
        }
    }
    if (count >= 64 || bytes + Buffer.byteLength(text) > 1024 * 1024)
        throw new Error(M.pluginSandbox.quota);
    const temporary = path.join(path.dirname(target), `.guard-${randomUUID()}.tmp`);
    let created = false;
    try {
        const fd = fs.openSync(temporary, "wx", 0o600);
        created = true;
        try {
            fs.writeFileSync(fd, text, "utf8");
        }
        finally {
            fs.closeSync(fd);
        }
        sandboxWriteTarget(root, id, file);
        fs.renameSync(temporary, target);
        created = false;
    }
    finally {
        if (created)
            fs.unlinkSync(temporary);
    }
}
//# sourceMappingURL=filesystem.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("plugin-sandbox/filesystem.ts", { loadSandboxSources, sandboxFilename, sandboxWriteTarget, writeSandboxText })
