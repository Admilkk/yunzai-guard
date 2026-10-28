import fs from "node:fs";
import promises from "node:fs/promises";
import path from "node:path";
import { Paths } from "./paths.js";
import { apply, objectPrototype as getPrototype, objectDescriptor as descriptor, objectSymbols as ownSymbols, objectDefine as define, newWeakMap, weakMapHas, weakMapGet, weakMapSet, weakMapDelete, newWeakSet, weakSetHas, weakSetAdd, arrayIncludes, arrayEach, promiseReject, promiseResolve, promiseThen, stringSlice, stringStartsWith, stringIndexOf, } from "./intrinsics.js";
const next = queueMicrotask;
const rawStream = fs.createWriteStream;
const rawReadStream = fs.createReadStream;
const rawRead = fs.read;
const rawWrite = fs.write;
const rawClose = fs.close;
const dirname = path.dirname;
const isAbsolute = path.isAbsolute;
const isBuffer = Buffer.isBuffer;
const fromBuffer = Buffer.from.bind(Buffer);
const bufferSubarray = Buffer.prototype.subarray;
const bufferEquals = Buffer.prototype.equals;
const flags = fs.constants;
const writableFlags = flags.O_WRONLY | flags.O_RDWR | flags.O_APPEND | flags.O_CREAT | flags.O_TRUNC;
/** 判断打开标志是否包含写入。 */
function writes(value) {
    return typeof value === "number"
        ? (value & writableFlags) !== 0
        : typeof value === "string" &&
            (stringIndexOf(value, "w") >= 0 ||
                stringIndexOf(value, "a") >= 0 ||
                stringIndexOf(value, "x") >= 0 ||
                stringIndexOf(value, "+") >= 0);
}
/** 判断打开标志是否包含读取。 */
function reads(value) {
    if (value === undefined)
        return true;
    return typeof value === "number"
        ? (value & (flags.O_WRONLY | flags.O_RDWR)) !== flags.O_WRONLY
        : typeof value === "string" &&
            (stringIndexOf(value, "r") >= 0 || stringIndexOf(value, "+") >= 0);
}
/** 流入口可用 options.fd 代替路径。 */
function streamTarget(args) {
    const options = args[1];
    return options && typeof options === "object" && options.fd != null ? options.fd : args[0];
}
/** 安装后不暴露卸载入口；可信宿主写入位于另一个进程。 */
export function installFileGuard(options) {
    const paths = new Paths(options.roots, options.deny);
    const secrets = new Paths(options.readRoots ?? [], options.deny);
    const handles = newWeakMap();
    const prototypes = newWeakSet();
    const relativeResults = newWeakMap();
    const seal = options.seal;
    const observe = (operation, target, write, source) => options.observe?.(operation, target, write, source);
    /** 固定路径参数快照；已登记的 FileHandle 原样返回。 */
    function snapshot(value, operation, readOnly = false, absolute = true) {
        return value && typeof value === "object" && weakMapHas(handles, value)
            ? value
            : paths.snapshot(value, operation, readOnly, absolute);
    }
    /** 返回原生 WriteStream，在 open 回调中按流语义报告拒绝。 */
    function deniedStream(name, error) {
        return rawStream((name ?? "guard-denied"), {
            fs: {
                /** 按流语义异步报告拒绝。 */
                open(_name, _flags, _mode, done) {
                    next(() => done(error, -1));
                },
                write: rawWrite,
                close: rawClose,
            },
        });
    }
    /** 返回在 open 阶段以 error 事件失败的读取流。 */
    function deniedReadStream(name, error) {
        return rawReadStream((name ?? "guard-denied"), {
            fs: {
                /** 按流语义异步报告拒绝。 */
                open(_name, _flags, _mode, done) {
                    next(() => done(error, -1));
                },
                read: rawRead,
                close: rawClose,
            },
        });
    }
    /** 检查读取目标是否位于保密目录。 */
    function checkRead(value, operation, ancestors = false) {
        if (value && typeof value === "object" && weakMapHas(handles, value))
            secrets.fd(weakMapGet(handles, value), operation);
        else
            secrets.check(value, operation, ancestors);
    }
    /** 检查写入目标是否位于受保护目录。 */
    function check(value, operation, ancestors = false) {
        if (value && typeof value === "object" && weakMapHas(handles, value))
            paths.fd(weakMapGet(handles, value), operation);
        else
            paths.check(value, operation, ancestors);
    }
    /** 包装一个 fs 入口：先检查参数，再按同步、回调、Promise 或流语义调用原入口。 */
    function replace(container, key, prepare, mode, after) {
        const original = container[key];
        if (typeof original !== "function")
            return;
        const wrapped = function (...args) {
            try {
                prepare(args);
            }
            catch (error) {
                if (mode === "promise")
                    return promiseReject(error);
                if (mode === "stream")
                    return deniedStream(args[0], error);
                if (mode === "read-stream")
                    return deniedReadStream(args[0], error);
                if (mode === "callback" && typeof args[args.length - 1] === "function") {
                    const callback = args[args.length - 1];
                    next(() => callback(error));
                    return;
                }
                throw error;
            }
            if (mode === "callback" && after && typeof args[args.length - 1] === "function") {
                const callback = args[args.length - 1];
                args[args.length - 1] = (error, value, ...rest) => {
                    if (!error)
                        value = after(value, args);
                    callback(error, value, ...rest);
                };
            }
            const value = apply(original, this, args);
            if (mode === "promise" && after)
                return promiseThen(promiseResolve(value), result => after(result, args));
            return mode === "sync" && after ? after(value, args) : value;
        };
        // fs.write/writev 的多返回值标记不能丢失，否则 promisify 会改变返回类型。
        arrayEach(ownSymbols(original), key => {
            const property = descriptor(original, key);
            if (typeof property.value !== "function")
                define(wrapped, key, property);
        });
        seal(container, key, wrapped);
    }
    /** 固定指定位置的路径参数并检查写入权限。 */
    function file(args, index, operation, ancestors = false) {
        args[index] = snapshot(args[index], operation);
        check(args[index], operation, ancestors);
    }
    /** 把 FileHandle 绑定到其 fd，并禁止之后改写 fd。 */
    function bindHandle(value, getter) {
        const known = weakMapGet(handles, value);
        if (known !== undefined)
            return known;
        const fd = apply(getter, value, []);
        if (typeof fd !== "number" || descriptor(value, "fd")?.configurable === false)
            options.deny("FileHandle.fd", "invalid-handle");
        define(value, "fd", {
            configurable: false,
            /** 返回当前 fd，发现被替换时拒绝。 */
            get() {
                const current = apply(getter, value, []);
                if (current !== fd && current !== -1)
                    options.deny("FileHandle.fd", "changed-descriptor");
                return current;
            },
            /** 禁止改写 fd。 */
            set() {
                options.deny("FileHandle.fd", "changed-descriptor");
            },
        });
        weakMapSet(handles, value, fd);
        return fd;
    }
    /** 为 FileHandle 及其原型的读写方法加上检查。 */
    function handle(value) {
        const prototype = getPrototype(value);
        const getter = descriptor(prototype, "fd")?.get;
        if (!getter)
            options.deny("FileHandle.fd", "missing-descriptor");
        bindHandle(value, getter);
        if (weakSetHas(prototypes, prototype))
            return value;
        weakSetAdd(prototypes, prototype);
        arrayEach([
            "appendFile",
            "chmod",
            "chown",
            "truncate",
            "utimes",
            "write",
            "writeFile",
            "writev",
            "createWriteStream",
        ], method => {
            const original = prototype[method];
            if (typeof original !== "function")
                return;
            seal(prototype, method, function (...args) {
                try {
                    paths.fd(bindHandle(this, getter), `FileHandle.${method}`);
                }
                catch (error) {
                    if (method === "createWriteStream")
                        return deniedStream("guard-denied", error);
                    return promiseReject(error);
                }
                return apply(original, this, args);
            });
        });
        arrayEach(["read", "readv", "readFile", "readLines", "readableWebStream", "createReadStream"], method => {
            const original = prototype[method];
            if (typeof original !== "function")
                return;
            seal(prototype, method, function (...args) {
                try {
                    secrets.fd(bindHandle(this, getter), `FileHandle.${method}`);
                }
                catch (error) {
                    if (method === "createReadStream")
                        return deniedReadStream("guard-denied", error);
                    if (method === "readLines" || method === "readableWebStream")
                        throw error;
                    return promiseReject(error);
                }
                return apply(original, this, args);
            });
        });
        const close = prototype.close;
        if (typeof close === "function")
            seal(prototype, "close", function (...args) {
                const fd = weakMapGet(handles, this);
                return promiseThen(promiseResolve(apply(close, this, args)), result => {
                    if (fd !== undefined) {
                        paths.forget(fd);
                        secrets.forget(fd);
                    }
                    weakMapDelete(handles, this);
                    return result;
                });
            });
        return value;
    }
    const singles = [
        "appendFile",
        "writeFile",
        "truncate",
        "chmod",
        "chown",
        "lchmod",
        "lchown",
        "utimes",
        "lutimes",
        "mkdir",
        "mkdtemp",
        "mkdtempDisposable",
        "rm",
        "rmdir",
        "unlink",
    ];
    for (const name of singles) {
        const ancestors = arrayIncludes(["rm", "rmdir", "unlink", "chmod", "chown", "lchmod", "lchown"], name);
        for (const [container, key, mode] of [
            [fs, name, "callback"],
            [fs, `${name}Sync`, "sync"],
            [promises, name, "promise"],
        ])
            replace(container, key, args => {
                const input = snapshot(args[0], `fs.${name}`, false, false);
                args[0] = input;
                file(args, 0, `fs.${name}`, ancestors);
                observe(`fs.${name}`, args[0], true);
                if (arrayIncludes(["mkdir", "mkdtemp", "mkdtempDisposable"], name) &&
                    typeof input === "string" &&
                    input &&
                    !isAbsolute(input))
                    weakMapSet(relativeResults, args, stringSlice(args[0], 0, args[0].length - input.length));
            }, mode, (value, args) => {
                const prefix = weakMapGet(relativeResults, args);
                if (!prefix)
                    return value;
                const relative = (name) => {
                    if (typeof name === "string")
                        return stringStartsWith(name, prefix) ? stringSlice(name, prefix.length) : name;
                    if (isBuffer(name)) {
                        const bytes = fromBuffer(prefix);
                        return apply(bufferEquals, apply(bufferSubarray, name, [0, bytes.length]), [bytes])
                            ? apply(bufferSubarray, name, [bytes.length])
                            : name;
                    }
                    return name;
                };
                if (value &&
                    typeof value === "object" &&
                    !isBuffer(value) &&
                    typeof value.path === "string")
                    return { ...value, path: relative(value.path) };
                return relative(value);
            });
    }
    for (const name of ["rename", "copyFile", "cp", "link", "symlink"]) {
        for (const [container, key, mode] of [
            [fs, name, "callback"],
            [fs, `${name}Sync`, "sync"],
            [promises, name, "promise"],
        ])
            replace(container, key, args => {
                // rename 会移走源；link/symlink 不能建立可写别名。
                if (arrayIncludes(["rename", "link"], name))
                    file(args, 0, `fs.${name}`, true);
                else
                    args[0] = snapshot(args[0], `fs.${name}`, name === "copyFile" || name === "cp", name !== "symlink");
                file(args, 1, `fs.${name}`, true);
                if (name !== "symlink")
                    checkRead(args[0], `fs.${name}`, true);
                if (name === "symlink" && typeof args[0] === "string" && typeof args[1] === "string") {
                    const target = isAbsolute(args[0])
                        ? args[0]
                        : `${dirname(args[1])}${path.sep}${args[0]}`;
                    paths.check(target, "fs.symlink", true);
                    secrets.check(target, "fs.symlink", true);
                }
                observe(`fs.${name}`, args[1], true, args[0]);
            }, mode);
    }
    for (const [container, key, mode] of [
        [fs, "open", "callback"],
        [fs, "openSync", "sync"],
        [promises, "open", "promise"],
    ])
        replace(container, key, args => {
            args[0] = snapshot(args[0], "fs.open", !writes(args[1]));
            if (writes(args[1]))
                check(args[0], "fs.open");
            if (reads(args[1]))
                checkRead(args[0], "fs.open");
            observe("fs.open", args[0], writes(args[1]));
        }, mode, (value, args) => {
            if (typeof value === "number") {
                paths.track(value, args[0]);
                secrets.track(value, args[0]);
            }
            else if (value && typeof value === "object") {
                handle(value);
                paths.track(weakMapGet(handles, value), args[0]);
                secrets.track(weakMapGet(handles, value), args[0]);
            }
            return value;
        });
    for (const name of ["write", "writev", "ftruncate", "fchmod", "fchown", "futimes"]) {
        replace(fs, name, args => paths.fd(args[0], `fs.${name}`), "callback");
        replace(fs, `${name}Sync`, args => paths.fd(args[0], `fs.${name}`), "sync");
    }
    for (const [container, key, mode] of [
        [fs, "readFile", "callback"],
        [fs, "readFileSync", "sync"],
        [promises, "readFile", "promise"],
    ])
        replace(container, key, args => {
            args[0] = snapshot(args[0], "fs.readFile", true);
            checkRead(args[0], "fs.readFile");
            if (args[1] && typeof args[1] === "object") {
                args[1] = { ...args[1], flag: args[1].flag };
                if (writes(args[1].flag))
                    check(args[0], "fs.readFile");
            }
            observe("fs.readFile", args[0], false);
        }, mode);
    for (const name of ["read", "readv"]) {
        replace(fs, name, args => secrets.fd(args[0], `fs.${name}`), "callback");
        replace(fs, `${name}Sync`, args => secrets.fd(args[0], `fs.${name}`), "sync");
    }
    replace(fs, "openAsBlob", args => {
        args[0] = snapshot(args[0], "fs.openAsBlob", true);
        checkRead(args[0], "fs.openAsBlob");
        observe("fs.openAsBlob", args[0], false);
    }, "promise");
    replace(fs, "createReadStream", args => {
        args[0] = snapshot(args[0], "fs.createReadStream", true);
        const value = args[1];
        if (value && typeof value === "object") {
            args[1] = { ...value, fd: value.fd, flags: value.flags };
            if (args[1].fd !== undefined && args[1].fd !== null)
                checkRead(args[1].fd, "fs.createReadStream");
            else
                checkRead(args[0], "fs.createReadStream");
            if (writes(args[1].flags))
                check(args[1].fd ?? args[0], "fs.createReadStream");
        }
        else
            checkRead(args[0], "fs.createReadStream");
        observe("fs.createReadStream", streamTarget(args), false);
    }, "read-stream");
    // close 不授予文件写权限；保留 graceful-fs 的全局关闭包装。
    // fd 复用由 fstat 身份校验和下次 open 的登记处理。
    replace(fs, "createWriteStream", args => {
        args[0] = snapshot(args[0], "fs.createWriteStream");
        const value = args[1];
        if (value && typeof value === "object") {
            args[1] = { ...value, fd: value.fd, flags: value.flags };
            if (args[1].fd !== undefined && args[1].fd !== null)
                check(args[1].fd, "fs.createWriteStream");
            else
                check(args[0], "fs.createWriteStream");
            if (args[1].flags !== undefined && reads(args[1].flags))
                checkRead(args[1].fd ?? args[0], "fs.createWriteStream");
        }
        else
            check(args[0], "fs.createWriteStream");
        observe("fs.createWriteStream", streamTarget(args), true);
    }, "stream");
}
//# sourceMappingURL=files.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "./objects.js"
__guardRegisterExports("protect/files.ts", { installFileGuard })
