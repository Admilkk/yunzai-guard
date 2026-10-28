import path from "node:path";
import { readFile, verifyFile } from "./files.js";
import { M } from "../shared/messages.js";
/** 分发的 broker 与源码摘要必须同时匹配，不在用户机器调用编译器。 */
export function windowsBroker(repository, sourceDigest) {
    const root = path.join(repository, "native/windows");
    const manifest = JSON.parse(readFile(path.join(root, "manifest.json"), 8192).toString("utf8"));
    if (manifest.schemaVersion !== 1 ||
        manifest.platform !== "win32" ||
        manifest.architecture !== "x64" ||
        manifest.sourceDigest !== sourceDigest ||
        manifest.file !== "bin/win32-x64/GuardSandbox.exe")
        throw new Error(M.dependencies.brokerMismatch);
    const executable = path.join(root, manifest.file);
    verifyFile(executable, manifest.sha256);
    return { executable, sha256: manifest.sha256 };
}
//# sourceMappingURL=windows-broker.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("dependencies/windows-broker.ts", { windowsBroker })
