import sqlite from "node:sqlite";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Paths } from "./paths.js";
import { refuse } from "./objects.js";
import { apply, objectCreate, objectDefine, objectDescriptor, newWeakMap, weakMapGet, weakMapSet, stringStartsWith, stringSlice, stringIndexOf, } from "./intrinsics.js";
const DatabaseClass = sqlite.DatabaseSync;
const prototype = DatabaseClass.prototype;
const nativeOpen = prototype.open;
const nativeAuthorizer = prototype.setAuthorizer;
const nativeBackup = sqlite.backup;
const construct = Reflect.construct;
const ProxyClass = Proxy;
const decode = decodeURIComponent;
const resolve = path.resolve;
const fileUrl = pathToFileURL;
const urlHref = objectDescriptor(URL.prototype, "href").get;
const windows = process.platform === "win32";
const attach = sqlite.constants.SQLITE_ATTACH;
const allow = sqlite.constants.SQLITE_OK;
let installed = false;
/** 包装 node:sqlite，禁止打开受保护数据库并记录缺少授权器的覆盖不足。 */
export function installSqliteGuard(options) {
    if (installed)
        refuse("runtime-reinstall", "sqlite");
    installed = true;
    const writes = new Paths(options.roots, options.deny);
    const reads = new Paths(options.readRoots ?? [], options.deny);
    const records = newWeakMap();
    let warnedDynamic = false;
    let warnedLegacy = false;
    const coverage = (legacy) => {
        if (legacy ? warnedLegacy : warnedDynamic)
            return;
        if (legacy)
            warnedLegacy = true;
        else
            warnedDynamic = true;
        try {
            options.emit?.({
                kind: "coverage",
                operation: "sqlite.authorizer",
                target: legacy ? "unavailable" : "dynamic-attach",
                action: "audit",
                details: { protected: false },
            });
        }
        catch { }
    };
    const filename = (value, operation, readOnly) => {
        const snapshot = writes.snapshot(value, operation, readOnly, false);
        if (typeof snapshot !== "string" || snapshot === "" || snapshot === ":memory:")
            return snapshot;
        let name = snapshot;
        let suffix = "";
        const uri = stringStartsWith(name, "file:");
        if (uri) {
            name = stringSlice(name, 5);
            const query = stringIndexOf(name, "?");
            const fragment = stringIndexOf(name, "#");
            const end = query < 0 ? fragment : fragment < 0 || query < fragment ? query : fragment;
            if (end >= 0) {
                suffix = stringSlice(name, end);
                name = stringSlice(name, 0, end);
            }
            if (stringStartsWith(name, "//")) {
                name = stringSlice(name, 2);
                if (stringStartsWith(name, "localhost/"))
                    name = stringSlice(name, 9);
                // SQLite 默认只接受空主机或 localhost。
                else if (!stringStartsWith(name, "/"))
                    return snapshot;
            }
            name = decode(name);
            if (!name || name === ":memory:")
                return snapshot;
            if (windows && name[0] === "/" && name[2] === ":")
                name = stringSlice(name, 1);
        }
        const absolute = resolve(name);
        reads.check(absolute, operation);
        if (!readOnly)
            writes.check(absolute, operation);
        return uri ? apply(urlHref, fileUrl(absolute), []) + suffix : absolute;
    };
    const authorize = (database, record) => {
        if (typeof nativeAuthorizer !== "function") {
            coverage(true);
            return;
        }
        apply(nativeAuthorizer, database, [
            (...args) => {
                const result = record.callback ? apply(record.callback, undefined, args) : allow;
                if (args[0] === attach) {
                    if (args[1] === null)
                        coverage(false);
                    else
                        filename(args[1], "sqlite.attach", false);
                }
                return result;
            },
        ]);
    };
    const GuardDatabase = new ProxyClass(DatabaseClass, {
        /** 构造数据库前检查路径与选项。 */
        construct(target, args, newTarget) {
            const input = args[1];
            let readOnly = false;
            let open = true;
            if (input && typeof input === "object") {
                const settings = objectCreate(input);
                const readonlyValue = input.readOnly;
                const openValue = input.open;
                objectDefine(settings, "readOnly", { value: readonlyValue });
                objectDefine(settings, "open", { value: openValue });
                args[1] = settings;
                readOnly = readonlyValue === true;
                open = openValue !== false;
            }
            args[0] = filename(args[0], "sqlite.open", readOnly);
            const database = construct(target, args, newTarget);
            const record = { filename: args[0], readOnly, callback: null };
            weakMapSet(records, database, record);
            if (open)
                authorize(database, record);
            return database;
        },
    });
    options.seal(sqlite, "DatabaseSync", GuardDatabase, "sqlite.DatabaseSync");
    options.seal(prototype, "constructor", GuardDatabase, "sqlite.DatabaseSync.constructor");
    options.seal(prototype, "open", function () {
        const record = weakMapGet(records, this);
        if (record)
            filename(record.filename, "sqlite.open", record.readOnly);
        const result = apply(nativeOpen, this, []);
        if (record) {
            record.callback = null;
            authorize(this, record);
        }
        return result;
    }, "sqlite.DatabaseSync.open");
    if (typeof nativeAuthorizer === "function")
        options.seal(prototype, "setAuthorizer", function (callback) {
            const record = weakMapGet(records, this);
            if (!record || (callback !== null && typeof callback !== "function"))
                return apply(nativeAuthorizer, this, [callback]);
            const previous = record.callback;
            record.callback = callback;
            try {
                authorize(this, record);
            }
            catch (error) {
                record.callback = previous;
                throw error;
            }
        }, "sqlite.DatabaseSync.setAuthorizer");
    options.seal(sqlite, "backup", function (...args) {
        args[1] = filename(args[1], "sqlite.backup", false);
        return apply(nativeBackup, sqlite, args);
    }, "sqlite.backup");
    if (typeof nativeAuthorizer !== "function")
        coverage(true);
}
//# sourceMappingURL=sqlite.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "./objects.js"
__guardRegisterExports("protect/sqlite.ts", { installSqliteGuard })
