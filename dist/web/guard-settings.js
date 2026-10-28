import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parseSettings } from "../config/index.js";
import { M } from "../shared/messages.js";
const maxSettingsBytes = 1024 * 1024;
/** 返回 Guard 配置文件路径。 */
export function guardSettingsPath(stateDir) {
    return path.join(stateDir, "settings.json");
}
/** 把配置转为可序列化的普通对象。 */
export function serializeSettings(settings) {
    return JSON.parse(JSON.stringify(settings));
}
/** 把配置序列化为用于比较的规范文本。 */
function canonical(settings) {
    return JSON.stringify(settings);
}
/** 判断为非数组的普通对象。 */
export function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
/** 读取磁盘上的配置；只有宿主能读这个目录，面板因此也运行在宿主进程。 */
export function readSettingsDocument(stateDir, active) {
    const file = guardSettingsPath(stateDir);
    const fallback = serializeSettings(active);
    let text;
    try {
        const info = fs.statSync(file);
        if (info.isFile() && info.size <= maxSettingsBytes)
            text = fs.readFileSync(file, "utf8");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    if (!text?.trim())
        return {
            path: file,
            document: fallback,
            text: `${JSON.stringify(fallback, null, 2)}\n`,
            source: "defaults",
            valid: true,
            pendingRestart: false,
        };
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        return {
            path: file,
            document: fallback,
            text,
            source: "defaults",
            valid: false,
            error: `settings.json 不是合法 JSON：${error.message}`,
            pendingRestart: false,
        };
    }
    if (!isPlainObject(parsed))
        return {
            path: file,
            document: fallback,
            text,
            source: "defaults",
            valid: false,
            error: "settings.json 顶层必须是 JSON 对象",
            pendingRestart: false,
        };
    try {
        const normalized = parseSettings(parsed);
        return {
            path: file,
            document: parsed,
            normalized: serializeSettings(normalized),
            text,
            source: "file",
            valid: true,
            pendingRestart: canonical(normalized) !== canonical(active),
        };
    }
    catch (error) {
        return {
            path: file,
            document: parsed,
            text,
            source: "file",
            valid: false,
            error: error.message,
            pendingRestart: false,
        };
    }
}
const historyKeep = 30;
/** 历史备份目录。 */
function historyDirectory(file) {
    return path.join(path.dirname(file), "settings-history");
}
/** 备份当前配置文件：覆盖最近一份 .bak，并在历史目录保留最近 30 份，返回备份路径。 */
function backupFile(file) {
    try {
        if (!fs.existsSync(file))
            return null;
        const target = `${file}.bak`;
        fs.copyFileSync(file, target);
        const directory = historyDirectory(file);
        fs.mkdirSync(directory, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        fs.copyFileSync(file, path.join(directory, `settings-${stamp}.json`));
        const names = fs
            .readdirSync(directory)
            .filter(name => /^settings-[\w-]+\.json$/.test(name))
            .sort();
        for (const name of names.slice(0, Math.max(0, names.length - historyKeep)))
            fs.rmSync(path.join(directory, name), { force: true });
        return target;
    }
    catch {
        return null;
    }
}
/** 列出历史配置备份，新的在前。 */
export function listSettingsBackups(stateDir) {
    const directory = historyDirectory(guardSettingsPath(stateDir));
    try {
        return fs
            .readdirSync(directory)
            .filter(name => /^settings-[\w-]+\.json$/.test(name))
            .sort()
            .reverse()
            .map(id => {
            const info = fs.statSync(path.join(directory, id));
            return { id, time: info.mtimeMs, size: info.size };
        });
    }
    catch {
        return [];
    }
}
/** 读取一份历史备份的文本；编号只接受备份文件名。 */
export function readSettingsBackup(stateDir, id) {
    if (!/^settings-[\w-]+\.json$/.test(id))
        return undefined;
    try {
        return fs.readFileSync(path.join(historyDirectory(guardSettingsPath(stateDir)), id), "utf8");
    }
    catch {
        return undefined;
    }
}
/** 校验后原子写入，配置应用由宿主处理。 */
export function writeSettingsDocument(stateDir, active, value) {
    if (!isPlainObject(value))
        throw new TypeError(M.web.settingsObject);
    const normalized = validateSettingsDocument(stateDir, value);
    const file = guardSettingsPath(stateDir);
    const backup = backupFile(file);
    const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(temporary, file);
    }
    finally {
        if (fs.existsSync(temporary))
            fs.rmSync(temporary, { force: true });
    }
    return { pendingRestart: canonical(normalized) !== canonical(active), backup };
}
/** 仅校验不落盘，供页面在保存前提示错误。 */
export function validateSettings(value) {
    if (!isPlainObject(value))
        throw new TypeError(M.web.settingsObject);
    return parseSettings(value);
}
/** 返回沙箱脚本目录。 */
export function sandboxScriptsDir(stateDir) {
    return path.join(stateDir, "scripts");
}
/** 命令沙盒脚本由用户在磁盘放置；面板只检查存在性，避免启用后宿主启动失败。 */
export function listSandboxScripts(stateDir) {
    const directory = sandboxScriptsDir(stateDir);
    let entries;
    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const result = [];
    for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".js"))
            continue;
        try {
            const info = fs.statSync(path.join(directory, entry.name));
            result.push({ id: entry.name.slice(0, -3), size: info.size });
        }
        catch {
            // 读取失败的文件不展示，交由启动阶段校验。
        }
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
}
/** 确认配置引用的沙箱脚本均存在。 */
function assertScripts(stateDir, settings) {
    const available = new Set(listSandboxScripts(stateDir).map(item => item.id));
    for (const plugin of settings.pluginSandbox.plugins) {
        if (!plugin.enabled || available.has(plugin.id))
            continue;
        throw new TypeError(M.web.scriptMissing(plugin.id, plugin.id));
    }
}
/** 校验面板提交的配置文档。 */
export function validateSettingsDocument(stateDir, value) {
    const settings = validateSettings(value);
    assertScripts(stateDir, settings);
    return settings;
}
//# sourceMappingURL=guard-settings.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("web/guard-settings.ts", { guardSettingsPath, serializeSettings, isPlainObject, readSettingsDocument, listSettingsBackups, readSettingsBackup, writeSettingsDocument, validateSettings, sandboxScriptsDir, listSandboxScripts, validateSettingsDocument })
