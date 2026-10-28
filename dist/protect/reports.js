import path from "node:path";
import { Paths } from "./paths.js";
import { apply, objectDefine, objectDescriptor, objectFreeze, arrayPush } from "./intrinsics.js";
const owner = process;
const report = process.report;
const write = report.writeReport;
const chdir = process.chdir;
const cwd = process.cwd.bind(process);
const resolve = path.resolve;
const sep = path.sep;
const keys = [
    "directory",
    "filename",
    "reportOnFatalError",
    "reportOnSignal",
    "reportOnUncaughtException",
];
const descriptors = Object.fromEntries(keys.map(key => [key, objectDescriptor(report, key)]));
/** 限制诊断报告的输出目录，禁止写入受保护路径。 */
export function installReportGuard(options) {
    const paths = new Paths(options.roots, options.deny);
    const pending = [];
    const read = (key) => apply(descriptors[key].get, report, []);
    const automatic = () => read("reportOnFatalError") || read("reportOnSignal") || read("reportOnUncaughtException");
    const check = (directory, filename, base = cwd()) => {
        if (filename === "stdout" || filename === "stderr")
            return;
        const target = directory ? `${directory}${sep}${filename}` : filename;
        paths.check(resolve(base, target || "."), "report-write");
    };
    const checkPending = (directory, filename, base = cwd()) => {
        for (let index = 0; index < pending.length; index++)
            check(directory, pending[index] || filename, base);
    };
    if (automatic())
        check(read("directory"), read("filename"));
    for (const key of keys) {
        const original = descriptors[key];
        const get = () => read(key);
        const set = (value) => {
            if ((key === "directory" || key === "filename") && typeof value === "string") {
                const directory = key === "directory" ? value : read("directory");
                const filename = key === "filename" ? value : read("filename");
                check(directory, filename);
                checkPending(directory, filename);
            }
            else if (value === true)
                check(read("directory"), read("filename"));
            apply(original.set, report, [value]);
        };
        objectFreeze(get);
        objectFreeze(set);
        objectDefine(report, key, {
            configurable: false,
            enumerable: original.enumerable,
            get,
            set,
        });
    }
    options.seal(report, "writeReport", function (...args) {
        const first = args[0];
        if (first !== undefined && typeof first !== "string" && (!first || typeof first !== "object"))
            return apply(write, report, args);
        const filename = typeof first === "string" && first ? first : undefined;
        check(read("directory"), filename || read("filename"));
        arrayPush(pending, filename);
        try {
            return apply(write, report, args);
        }
        finally {
            pending.length--;
        }
    });
    const guardedChdir = function (directory) {
        if (typeof directory === "string" && (automatic() || pending.length)) {
            const base = resolve(cwd(), directory);
            if (automatic())
                check(read("directory"), read("filename"), base);
            checkPending(read("directory"), read("filename"), base);
        }
        return apply(chdir, owner, [directory]);
    };
    // graceful-fs 会包装 chdir；真实切换仍须经过此闭包，原生入口不外露。
    objectFreeze(guardedChdir);
    objectDefine(owner, "chdir", { ...objectDescriptor(owner, "chdir"), value: guardedChdir });
}
//# sourceMappingURL=reports.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "./objects.js"
__guardRegisterExports("protect/reports.ts", { installReportGuard })
