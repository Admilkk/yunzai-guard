import path from "node:path";
import { newWeakMap, objectDefine, stringLower, weakMapGet, weakMapSet } from "./intrinsics.js";
const capturedProcess = process;
const windows = process.platform === "win32";
const systemCmd = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
const implicitShells = newWeakMap();
// Node 的 exec 会克隆 options，但保留 env；只传递同一个系统 cmd 的私有来源记录。
const implicitEnvironments = newWeakMap();
const NativeTypeError = TypeError;
function comparable(value) {
    let result = "";
    for (let index = 0; index < value.length; index++)
        result += value[index] === "/" ? "\\" : value[index];
    return stringLower(result);
}
const comparableSystemCmd = comparable(systemCmd);
function recorded(records, object, value) {
    return object !== null && typeof object === "object" && weakMapGet(records, object) === value;
}
/** 固定 Windows 实际使用的隐式 shell，环境和归因回调后续变化不再影响启动。 */
export function snapshotCommandShell(operation, options, previous, previousEnvironment) {
    if (!windows)
        return;
    const supplied = options.shell;
    let implicit = false;
    if (typeof supplied === "string") {
        implicit =
            recorded(implicitShells, previous, supplied) ||
                recorded(implicitEnvironments, previousEnvironment, supplied);
    }
    else if (operation === "exec" || operation === "execSync" || supplied === true) {
        const requested = capturedProcess.env.comspec;
        if (requested && typeof requested !== "string") {
            const error = new NativeTypeError('The "process.env.comspec" property must be a string');
            objectDefine(error, "code", { value: "ERR_INVALID_ARG_TYPE" });
            throw error;
        }
        const shell = requested || "cmd.exe";
        implicit = comparable(shell) === "cmd.exe" || comparable(shell) === comparableSystemCmd;
        options.shell = implicit ? systemCmd : shell;
    }
    if (!implicit)
        return;
    options.shell = systemCmd;
    weakMapSet(implicitShells, options, systemCmd);
    if (options.env !== null && typeof options.env === "object")
        weakMapSet(implicitEnvironments, options.env, systemCmd);
}
/** 只豁免本次快照记录且 shell 值未变化的系统 cmd，调用者属性不能伪造来源。 */
export function isImplicitSystemShell(options, shell) {
    return windows && typeof shell === "string" && recorded(implicitShells, options, shell);
}
//# sourceMappingURL=command-shell.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "./objects.js"
__guardRegisterExports("protect/command-shell.ts", { snapshotCommandShell, isImplicitSystemShell })
