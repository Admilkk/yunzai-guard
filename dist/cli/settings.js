import fs from "node:fs";
import path from "node:path";
import { parseSettings } from "../config/index.js";
import { M } from "../shared/messages.js";
import { isOrdinaryFile } from "../shared/files.js";
import { parseSettingsText, settingsFiles, writeLegacyMirror } from "../config/settings-file.js";
export const maxSettingsBytes = 1024 * 1024;
/** 判断错误是否为文件不存在。 */
function missing(error) {
    return error.code === "ENOENT";
}
/** 安装目录及其父目录可信；拒绝受管根目录内的路径别名。 */
export function directory(root, parts, create) {
    let current = path.resolve(root);
    for (const part of ["", ...parts]) {
        if (part)
            current = path.join(current, part);
        if (create && part) {
            try {
                fs.mkdirSync(current, { mode: 0o700 });
            }
            catch (error) {
                if (error.code !== "EEXIST")
                    throw error;
            }
        }
        try {
            const stat = fs.lstatSync(current);
            if (!stat.isDirectory() || stat.isSymbolicLink())
                throw new Error(M.cli.pathNotDirectory(current));
        }
        catch (error) {
            if (part && !create && missing(error))
                continue;
            throw error;
        }
    }
    return current;
}
/** 读取配置文件，不存在时返回 undefined。 */
export function readConfig(filename) {
    try {
        const stat = fs.lstatSync(filename);
        if (!isOrdinaryFile(stat, maxSettingsBytes))
            throw new Error(M.cli.settingsFile);
        const value = fs.readFileSync(filename);
        if (value.length > maxSettingsBytes)
            throw new Error(M.cli.settingsOversize);
        return value;
    }
    catch (error) {
        if (missing(error))
            return undefined;
        throw error;
    }
}
/** 解码配置字节；YAML 允许 BOM，旧版 JSON 保持原有要求。 */
function decode(bytes, yaml) {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.charCodeAt(0) !== 0xfeff)
        return text;
    if (!yaml)
        throw new Error(M.cli.settingsEncoding);
    return text.slice(1);
}
/** 本次修改实际读取的文件及其原始字节，用于备份。 */
export function configOrigin(config) {
    return config.original ? { filename: config.filename, bytes: config.original } : config.legacy;
}
/** 确认读取过的配置文件在提交前都未被他人修改。 */
export function configUnchanged(config) {
    unchanged(config.filename, config.original);
    if (config.legacy)
        unchanged(config.legacy.filename, config.legacy.bytes);
}
/** 读取并校验用户配置：优先 settings.yaml，只有旧版 settings.json 时读取它，写入时转换为 YAML。 */
export function readUserConfig(state) {
    const filename = path.join(state, settingsFiles.user);
    const original = readConfig(filename);
    if (original) {
        const text = decode(original, true);
        const value = parseSettingsText(text);
        parseSettings(value);
        return { filename, original, text, value };
    }
    const legacyName = path.join(state, settingsFiles.legacy);
    const legacy = readConfig(legacyName);
    const value = legacy ? JSON.parse(decode(legacy, false)) : {};
    parseSettings(value);
    return {
        filename,
        ...(legacy ? { legacy: { filename: legacyName, bytes: legacy } } : {}),
        value: value,
    };
}
/** 确认配置文件自读取后未被修改。 */
export function unchanged(filename, expected) {
    const actual = readConfig(filename);
    if (actual === undefined ? expected !== undefined : !expected || !actual.equals(expected))
        throw new Error(M.cli.settingsChanged);
}
/** 独占创建文件并记录其身份，供之后安全删除。 */
export function createFile(filename, content) {
    const fd = fs.openSync(filename, "wx", 0o600);
    const stat = fs.fstatSync(fd);
    const owned = { name: filename, dev: stat.dev, ino: stat.ino };
    try {
        fs.writeFileSync(fd, content);
        fs.fsyncSync(fd);
    }
    catch (error) {
        fs.closeSync(fd);
        removeOwned(owned);
        throw error;
    }
    fs.closeSync(fd);
    return owned;
}
/** 仅在身份未变时删除自己创建的文件。 */
export function removeOwned(file) {
    try {
        const current = fs.lstatSync(file.name);
        if (current.dev === file.dev && current.ino === file.ino && !current.isSymbolicLink())
            fs.unlinkSync(file.name);
    }
    catch (error) {
        if (!missing(error))
            throw error;
    }
}
/** 同步旧版本回退用的 settings.json；失败时由下次宿主启动补齐。 */
export function syncLegacy(state, value) {
    try {
        writeLegacyMirror(state, value);
    }
    catch {
        // 镜像只供回退旧版本使用。
    }
}
//# sourceMappingURL=settings.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("cli/settings.ts", { maxSettingsBytes, directory, readConfig, configOrigin, configUnchanged, readUserConfig, unchanged, createFile, removeOwned, syncLegacy })
