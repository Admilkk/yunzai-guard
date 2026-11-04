import fs from "node:fs";
import path from "node:path";
import { types } from "node:util";
import { arrayPush, objectDescriptor, objectKeys, regexpTest, stringIndexOf, stringLower, stringSlice, stringSplit, stringStartsWith, stringEndsWith, } from "./intrinsics.js";
const stat = fs.statSync;
const access = fs.accessSync;
const executeAccess = fs.constants.X_OK;
const open = fs.openSync;
const read = fs.readSync;
const close = fs.closeSync;
const realpath = fs.realpathSync.native;
const isProxy = types.isProxy;
const isAbsolute = path.isAbsolute;
const separator = path.sep;
const capturedProcess = process;
const windows = capturedProcess.platform === "win32";
const ownExecutable = capturedProcess.execPath;
const maxText = 128 * 1024;
const maxDirectories = 64;
const maxExtensions = 32;
const regularMask = BigInt(fs.constants.S_IFMT);
const regularFile = BigInt(fs.constants.S_IFREG);
const bytes = Uint8Array;
const scriptExtension = /\.(?:[cm]?js|jsx|jse|ts|tsx|sh|bash|zsh|fish|py|pyw|pl|rb|php|lua|ps1|bat|cmd|vbs|vbe|wsf|wsh|hta)$/i;
function identity(file) {
    try {
        return stat(file, { bigint: true });
    }
    catch {
        return undefined;
    }
}
const ownIdentity = identity(ownExecutable);
let ownCanonical = ownExecutable;
try {
    ownCanonical = realpath(ownExecutable);
}
catch {
    // AppContainer 可能不允许读取已知 Node 路径的祖先元数据。
}
const equal = (a, b) => (windows ? stringLower(a) === stringLower(b) : a === b);
/** 拼接保留 ..；先交给系统解析链接，不能用词法折叠改变实际执行目标。 */
function absolute(file, directory) {
    if (windows && regexpTest(/^[a-z]:(?:$|[^\\/])/i, file))
        return undefined;
    if (windows && regexpTest(/^[\\/](?![\\/])/, file)) {
        if (!regexpTest(/^[a-z]:[\\/]/i, directory))
            return undefined;
        return stringSlice(directory, 0, 2) + file;
    }
    return isAbsolute(file) ? file : `${directory}${separator}${file}`;
}
/** 只取启动快照的数据属性；Windows 与 Node 一致采用字典序首个大小写同名键。 */
function environmentValue(environment, name) {
    if (!environment || typeof environment !== "object")
        return { found: false };
    if (isProxy(environment))
        return { found: false, limited: true };
    let selected;
    try {
        const keys = objectKeys(environment);
        if (keys.length > 4096)
            return { found: false, limited: true };
        for (let index = 0; index < keys.length; index++) {
            const key = keys[index];
            if ((windows ? stringLower(key) === stringLower(name) : key === name) &&
                (selected === undefined || key < selected))
                selected = key;
        }
        if (selected === undefined)
            return { found: false };
        const descriptor = objectDescriptor(environment, selected);
        if (!descriptor || !("value" in descriptor))
            return { found: true, limited: true };
        if (descriptor.value === undefined)
            return { found: false };
        return typeof descriptor.value === "string"
            ? { found: true, value: descriptor.value }
            : { found: true, limited: true };
    }
    catch {
        return { found: false, limited: true };
    }
}
function inheritedEnvironment() {
    return objectDescriptor(capturedProcess, "env")?.value;
}
/** 按实际搜索环境识别入口，不执行文件，只读取两个 shebang 字节。 */
export function resolveCommandExecutable(file, directory, environment, shell = false) {
    const fromName = regexpTest(scriptExtension, file);
    const empty = { script: fromName, node: false };
    if (!file || file.length > maxText || regexpTest(/[\0\r\n]/, file))
        return { ...empty, limited: true };
    const direct = isAbsolute(file) || stringIndexOf(file, "/") >= 0 || (windows && stringIndexOf(file, "\\") >= 0);
    const locations = [];
    let clipped = false;
    if (direct) {
        const candidate = absolute(file, directory);
        if (!candidate)
            return { ...empty, limited: true };
        arrayPush(locations, candidate);
    }
    else {
        if (windows) {
            const local = absolute(file, directory);
            if (!local)
                return { ...empty, limited: true };
            arrayPush(locations, local);
        }
        const current = environmentValue(environment ?? inheritedEnvironment(), "PATH");
        if (current.limited)
            return { ...empty, limited: true };
        let search = current.value;
        if (!current.found) {
            if (environment !== undefined && !windows)
                search = "/usr/bin:/bin";
            else {
                const inherited = environmentValue(inheritedEnvironment(), "PATH");
                if (inherited.limited)
                    return { ...empty, limited: true };
                search = inherited.value;
            }
        }
        if (search !== undefined) {
            if (search.length > maxText)
                return { ...empty, limited: true };
            const directories = stringSplit(search, windows ? ";" : ":");
            clipped = directories.length > maxDirectories;
            for (let index = 0; index < directories.length && index < maxDirectories; index++) {
                let entry = directories[index];
                if (windows && stringStartsWith(entry, '"') && stringEndsWith(entry, '"'))
                    entry = stringSlice(entry, 1, -1);
                const folder = entry ? absolute(entry, directory) : directory;
                if (!folder)
                    return { ...empty, limited: true };
                arrayPush(locations, `${folder}${separator}${file}`);
            }
        }
    }
    const hasExtension = regexpTest(/\.[^\\/]+$/, file);
    let extensions = windows && !shell ? [".com", ".exe"] : [];
    if (windows && shell && !hasExtension) {
        const supplied = environmentValue(environment ?? inheritedEnvironment(), "PATHEXT");
        if (supplied.limited)
            return { ...empty, limited: true };
        const text = supplied.found ? supplied.value : ".COM;.EXE;.BAT;.CMD";
        if (text.length > 4096)
            return { ...empty, limited: true };
        const values = stringSplit(text, ";");
        if (values.length > maxExtensions)
            return { ...empty, limited: true };
        extensions = [];
        for (let index = 0; index < values.length; index++) {
            if (!values[index])
                continue;
            if (!regexpTest(/^\.[a-z\d]+$/i, values[index]))
                return { ...empty, limited: true };
            arrayPush(extensions, values[index]);
        }
    }
    for (let index = 0; index < locations.length; index++) {
        const candidate = locations[index];
        const names = [];
        if (!windows || !shell || hasExtension)
            arrayPush(names, candidate);
        if (windows && !hasExtension)
            for (let extension = 0; extension < extensions.length; extension++)
                arrayPush(names, candidate + extensions[extension]);
        if (windows && shell && !hasExtension)
            arrayPush(names, candidate);
        for (let at = 0; at < names.length; at++) {
            const name = names[at];
            if (equal(name, ownExecutable))
                return { path: name, script: false, node: true };
            let fd;
            try {
                const metadata = stat(name, { bigint: true });
                if ((metadata.mode & regularMask) !== regularFile)
                    continue;
                if (!windows)
                    try {
                        access(name, executeAccess);
                    }
                    catch (error) {
                        if (error.code === "EACCES")
                            continue;
                        throw error;
                    }
                let node = ownIdentity !== undefined &&
                    ownIdentity.ino !== 0n &&
                    metadata.ino === ownIdentity.ino &&
                    metadata.dev === ownIdentity.dev;
                if (!node) {
                    try {
                        node = equal(realpath(name), ownCanonical);
                    }
                    catch {
                        // 文件身份可用时不依赖额外的规范路径查询。
                    }
                }
                if (node)
                    return { path: name, script: false, node: true };
                if (regexpTest(scriptExtension, name))
                    return { path: name, script: true, node: false };
                fd = open(name, "r");
                const header = new bytes(2);
                const count = read(fd, header, 0, 2, 0);
                return {
                    path: name,
                    script: count === 2 && header[0] === 35 && header[1] === 33,
                    node: false,
                };
            }
            catch (error) {
                const code = error.code;
                if (code !== "ENOENT" && code !== "ENOTDIR")
                    return { ...empty, limited: true };
            }
            finally {
                if (fd !== undefined)
                    close(fd);
            }
        }
    }
    return { ...empty, ...(clipped ? { limited: true } : {}) };
}
//# sourceMappingURL=command-resolution.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "./objects.js"
__guardRegisterExports("protect/command-resolution.ts", { resolveCommandExecutable })
