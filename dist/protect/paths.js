import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { apply, newMap, mapSet, mapGet, mapDelete, arrayEach, arrayPush, numberIsInteger, stringStartsWith, stringEndsWith, stringSlice, stringLower, objectDescriptor, objectPrototype, objectDefine, } from "./intrinsics.js";
import { M } from "../shared/messages.js";
const realpath = fs.realpathSync.native;
const readlink = fs.readlinkSync;
const fstat = fs.fstatSync;
const { resolve, relative, isAbsolute, join, dirname, basename } = path;
const separator = path.sep;
const platform = process.platform;
const urlPath = fileURLToPath;
const isBytes = types.isUint8Array;
const Bytes = Uint8Array;
const setBytes = Uint8Array.prototype.set;
const byteLength = objectDescriptor(objectPrototype(Uint8Array.prototype), "length").get;
const PathError = TypeError;
const cwd = process.cwd.bind(process);
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const decode = decoder.decode.bind(decoder);
const looseDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
const decodeLoose = looseDecoder.decode.bind(looseDecoder);
const encoder = new TextEncoder();
const encode = encoder.encode.bind(encoder);
/** Windows 下去掉设备前缀并转为小写，便于比较。 */
const normalize = (value) => {
    if (platform !== "win32")
        return value;
    const lower = stringLower(value);
    if (stringStartsWith(lower, "\\\\?\\unc\\"))
        value = `\\\\${stringSlice(value, 8)}`;
    else if (stringStartsWith(value, "\\\\?\\") || stringStartsWith(value, "\\\\.\\"))
        value = stringSlice(value, 4);
    return stringLower(value);
};
/** 判断 value 是否位于 root 内（含 root 本身）。 */
export function within(root, value) {
    const name = relative(root, value);
    return !name || (!isAbsolute(name) && name !== ".." && !stringStartsWith(name, `..${separator}`));
}
/** 仅使用捕获的只读入口，避免包装器递归调用。 */
export class Paths {
    #roots;
    #fds = newMap();
    #deny;
    /** 登记受保护根目录。 */
    constructor(roots, deny) {
        this.#deny = deny;
        this.#roots = [];
        arrayEach(roots, root => {
            const lexical = resolve(root);
            arrayPush(this.#roots, normalize(lexical));
            arrayPush(this.#roots, normalize(this.#canonical(lexical)));
        });
    }
    /** Node 也接受 Uint8Array 和 URL-like，检查与调用必须使用同一份路径。 */
    snapshot(value, operation, readOnly = false, absolute = true) {
        if (typeof value === "string")
            return absolute && value && !isAbsolute(value) ? `${cwd()}${separator}${value}` : value;
        if (isBytes(value)) {
            const copy = new Bytes(value);
            try {
                return this.snapshot(decode(copy), operation, readOnly, absolute);
            }
            catch {
                if (!readOnly)
                    this.#deny(operation, "non-utf8-path");
                const text = decodeLoose(copy);
                if (!absolute || !text || isAbsolute(text))
                    return copy;
                const prefix = encode(`${cwd()}${separator}`);
                const offset = apply(byteLength, prefix, []);
                const full = new Bytes(offset + apply(byteLength, copy, []));
                apply(setBytes, full, [prefix]);
                apply(setBytes, full, [copy, offset]);
                return full;
            }
        }
        if (value && typeof value === "object") {
            const name = urlPath(value);
            if (typeof name === "string")
                return this.snapshot(name, operation, readOnly, absolute);
            const failure = new PathError(M.protect.pathType);
            objectDefine(failure, "code", { value: "ERR_INVALID_ARG_TYPE" });
            throw failure;
        }
        return value;
    }
    /** 把路径解析为规范化的真实路径。 */
    #canonical(value) {
        if (typeof value !== "string") {
            try {
                return realpath(value);
            }
            catch {
                value = decodeLoose(value);
            }
        }
        let cursor = value;
        const suffix = [];
        for (;;) {
            try {
                let resolved = realpath(cursor);
                for (let index = suffix.length - 1; index >= 0; index--)
                    resolved = join(resolved, suffix[index]);
                return resolved;
            }
            catch {
                const parent = dirname(cursor);
                if (parent === cursor)
                    return value;
                arrayPush(suffix, basename(cursor));
                cursor = parent;
            }
        }
    }
    /** 检查路径或 fd 是否落在受保护目录，必要时同时检查祖先目录。 */
    check(value, operation, ancestors = false) {
        if (typeof value === "number") {
            this.fd(value, operation);
            return;
        }
        if (typeof value !== "string" && !isBytes(value))
            return;
        const text = typeof value === "string" ? value : decodeLoose(value);
        const absolute = isAbsolute(text) ? text : `${cwd()}${separator}${text}`;
        const lexical = resolve(absolute);
        const candidates = [
            normalize(lexical),
            normalize(this.#canonical(typeof value === "string" ? absolute : value)),
        ];
        arrayEach(this.#roots, root => {
            arrayEach(candidates, candidate => {
                if (within(root, candidate) || (ancestors && within(candidate, root)))
                    this.#deny(operation, lexical);
            });
        });
    }
    /** 登记 fd 与打开时的路径身份。 */
    track(fd, value) {
        if (!numberIsInteger(fd) || (typeof value !== "string" && !isBytes(value)))
            return;
        const text = typeof value === "string" ? value : decodeLoose(value);
        const name = isAbsolute(text) ? text : `${cwd()}${separator}${text}`;
        try {
            const { dev, ino } = fstat(fd);
            mapSet(this.#fds, fd, {
                name: this.#canonical(typeof value === "string" ? name : value),
                dev,
                ino,
            });
        }
        catch {
            // 返回值无效时保留原调用结果，后续由 Node 检查 fd。
        }
    }
    /** 移除已关闭 fd 的登记。 */
    forget(fd) {
        mapDelete(this.#fds, fd);
    }
    /** 检查 fd 指向的文件是否受保护。 */
    fd(fd, operation) {
        // Linux 可核验安装前打开的常规文件；socket/pipe 不视为文件路径。
        if (platform === "linux" && numberIsInteger(fd)) {
            let name;
            try {
                name = readlink(`/proc/self/fd/${fd}`);
            }
            catch {
                // 系统未提供 fd 路径时，回退到本实例登记。
            }
            if (name && isAbsolute(name)) {
                this.check(stringEndsWith(name, " (deleted)") ? stringSlice(name, 0, -10) : name, operation);
                return;
            }
        }
        const record = mapGet(this.#fds, fd);
        if (!record)
            return;
        // fd 可能被外部代码关闭后复用；与当前文件身份不同时不沿用旧映射。
        try {
            const current = fstat(fd);
            if (current.dev !== record.dev || current.ino !== record.ino)
                return;
        }
        catch {
            return;
        }
        this.check(record.name, operation);
    }
}
//# sourceMappingURL=paths.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "./objects.js"
__guardRegisterExports("protect/paths.ts", { within, Paths })
