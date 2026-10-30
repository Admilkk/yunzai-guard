import fs from "node:fs";
import path from "node:path";
import { parseSettings, settingsDefaults } from "../config/index.js";
import { parseSettingsSource, parseSettingsText, readSettingsSource, renderSettings, settingsFiles, starterSettingsText, writeSettingsText, } from "../config/settings-file.js";
import { M } from "../shared/messages.js";
/** 返回 Guard 配置文件路径。 */
export function guardSettingsPath(stateDir) {
    return path.join(stateDir, settingsFiles.user);
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
    const fallback = serializeSettings(active);
    let source;
    try {
        source = readSettingsSource(stateDir);
    }
    catch (error) {
        return {
            path: guardSettingsPath(stateDir),
            document: fallback,
            text: "",
            source: "defaults",
            valid: false,
            error: error.message,
            pendingRestart: false,
        };
    }
    if (!source?.text.trim())
        return {
            path: guardSettingsPath(stateDir),
            document: fallback,
            text: source?.text ?? starterSettingsText(),
            source: "defaults",
            valid: true,
            pendingRestart: false,
        };
    let parsed;
    try {
        parsed = parseSettingsSource(source);
    }
    catch (error) {
        return {
            path: source.file,
            document: fallback,
            text: source.text,
            source: "defaults",
            valid: false,
            error: error.message,
            pendingRestart: false,
        };
    }
    try {
        const normalized = parseSettings(parsed);
        return {
            path: source.file,
            document: parsed,
            normalized: serializeSettings(normalized),
            text: source.text,
            source: "file",
            valid: true,
            pendingRestart: canonical(normalized) !== canonical(active),
        };
    }
    catch (error) {
        return {
            path: source.file,
            document: parsed,
            text: source.text,
            source: "file",
            valid: false,
            error: error.message,
            pendingRestart: false,
        };
    }
}
const historyKeep = 30;
const backupName = /^settings-[\w-]+\.(?:json|yaml)$/;
/** 历史备份目录。 */
function historyDirectory(stateDir) {
    return path.join(stateDir, "settings-history");
}
/** 备份当前配置文件：覆盖最近一份 .bak，并在历史目录保留最近 30 份，返回备份路径。 */
function backupFile(stateDir) {
    try {
        const source = readSettingsSource(stateDir);
        if (!source)
            return null;
        const target = `${source.file}.bak`;
        fs.copyFileSync(source.file, target);
        const directory = historyDirectory(stateDir);
        fs.mkdirSync(directory, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        fs.copyFileSync(source.file, path.join(directory, `settings-${stamp}.${source.format}`));
        const names = fs
            .readdirSync(directory)
            .filter(name => backupName.test(name))
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
    const directory = historyDirectory(stateDir);
    try {
        return fs
            .readdirSync(directory)
            .filter(name => backupName.test(name))
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
/** 读取一份历史备份；编号只接受备份文件名。YAML 备份同时返回原文，恢复时可保留注释。 */
export function readSettingsBackup(stateDir, id) {
    if (!backupName.test(id))
        return undefined;
    let text;
    try {
        text = fs.readFileSync(path.join(historyDirectory(stateDir), id), "utf8");
    }
    catch {
        return undefined;
    }
    if (id.endsWith(".yaml"))
        return { document: parseSettingsText(text, id), raw: text };
    return { document: parseSettingsSource({ file: id, format: "json", text }) };
}
/**
 * 校验后原子写入，配置应用由宿主处理。传入 raw 时按原文写入；否则在现有 settings.yaml 上
 * 只改变化的值，保留注释与顺序，并且不新增与默认值相同的项。
 */
export function writeSettingsDocument(stateDir, active, value, raw) {
    if (!isPlainObject(value))
        throw new TypeError(M.web.settingsObject);
    const normalized = validateSettingsDocument(stateDir, value);
    const source = readSettingsSource(stateDir);
    // 尚未转换的旧版 settings.json 先完整转换（保留其中所有项），再在其上应用修改。
    const previous = source?.format === "json" ? renderSettings(parseSettingsSource(source)) : source?.text;
    const text = raw ?? renderSettings(value, { previous, defaults: settingsDefaults(), omitDefaults: true });
    const backup = backupFile(stateDir);
    writeSettingsText(stateDir, text);
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
