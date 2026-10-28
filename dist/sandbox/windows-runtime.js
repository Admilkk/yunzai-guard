import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { M } from "../shared/messages.js";
/** 保留早期管道候选供显式选择，不授予元数据能力。 */
export const privateWindowsRuntimeCandidate = Object.freeze({
    directory: ".cache/private-node/v24.22.1-appcontainer-win-x64/runtime",
    nodeVersion: "24.22.1",
    modules: "137",
    sha256: "ed7ecd315bab189c03fd7d6c9315131ee680773a461cc4f0c6ad7b822d252736",
    buildManifestSha256: "e26d923e32948e4b5d451484f5511abeff29b18d643aadc2dc44612db221dcc0",
});
/** 仅配合 Guard 受控 Windows 路径与子进程启动语义使用。 */
export const privateWindowsCanonicalRuntimeCandidate = Object.freeze({
    directory: ".cache/private-node/v24.22.1-appcontainer-canonical-v2-final-win-x64/runtime",
    nodeVersion: "24.22.1",
    modules: "137",
    sha256: "781b7cf11f82c37bd34766744cfff805b3c1c24db560b6514e5f1ab7fa068c21",
    buildManifestSha256: "573a989fcf1d2e5f791f3f806a837432666eab9b2022607f21c94d8053c25008",
    osVerificationSha256: "98ff99fb613e73f2360425752249213d2d06c08d3e5c933ea646822b09d3d735",
});
/** 计算 SHA-256 摘要。 */
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** 读取有大小上限的普通文件。 */
function ordinaryFile(file, maximum) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum)
        throw new Error(M.sandbox.privateFiles);
    return fs.readFileSync(file);
}
/** 仅接受可信宿主选择，不接受插件提供的路径或回退到不同 ABI。 */
export function verifyPrivateWindowsRuntime(selection, host = process) {
    const canonical = selection.sha256 === privateWindowsCanonicalRuntimeCandidate.sha256;
    const candidate = canonical
        ? privateWindowsCanonicalRuntimeCandidate
        : privateWindowsRuntimeCandidate;
    if (host.platform !== "win32" ||
        host.arch !== "x64" ||
        host.versions.node !== candidate.nodeVersion ||
        host.versions.modules !== candidate.modules)
        throw new Error(M.sandbox.privateNode);
    if (selection.sha256 !== candidate.sha256)
        throw new Error(M.sandbox.privateCandidate);
    const directory = path.resolve(selection.directory);
    if (!fs.lstatSync(directory).isDirectory() ||
        fs.realpathSync.native(directory).toLowerCase() !== directory.toLowerCase())
        throw new Error(M.sandbox.privateReparse);
    const manifestBytes = ordinaryFile(path.join(directory, "build-manifest.json"), 65536);
    if (digest(manifestBytes) !== candidate.buildManifestSha256)
        throw new Error(M.sandbox.privateBuild);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const verificationBytes = ordinaryFile(path.join(directory, "os-verification.json"), 65536);
    if (canonical &&
        digest(verificationBytes) !== privateWindowsCanonicalRuntimeCandidate.osVerificationSha256)
        throw new Error(M.sandbox.privateOs);
    const verification = JSON.parse(verificationBytes.toString("utf8"));
    if (manifest.platform !== "win32" ||
        manifest.architecture !== "x64" ||
        manifest.versions?.node !== candidate.nodeVersion ||
        manifest.versions?.modules !== candidate.modules ||
        manifest.executableSha256 !== candidate.sha256 ||
        verification.schemaVersion !== 1 ||
        verification.status !== "passed" ||
        verification.scope !== "windows-appcontainer-private-runtime" ||
        verification.platform !== "win32" ||
        verification.architecture !== "x64" ||
        verification.nodeVersion !== candidate.nodeVersion ||
        verification.modules !== candidate.modules ||
        verification.runtimeSha256 !== candidate.sha256 ||
        verification.buildManifestSha256 !== candidate.buildManifestSha256 ||
        verification.cleanupConfirmed !== true ||
        verification.nativeSdkRequested !== true ||
        verification.originalNodeReadAfterTeardown !== true)
        throw new Error(M.sandbox.privateAcceptance);
    if (canonical &&
        (manifest.canonicalMetadataProtocol !== 1 ||
            manifest.windowsJsRealpathAncestorFallback !== 1 ||
            verification.canonicalMetadataProtocol !== 1 ||
            verification.windowsJsRealpathAncestorFallback !== 1 ||
            verification.childLaunchCompatibility !== "guard-preserve-flags" ||
            verification.controlledChildLaunchConfirmed !== true ||
            verification.originalGuestExitZero !== true))
        throw new Error(M.sandbox.privateMetadata);
    const executable = path.join(directory, "node.exe");
    if (digest(ordinaryFile(executable, 256 * 1024 * 1024)) !== candidate.sha256)
        throw new Error(M.sandbox.privateDigest);
    return {
        executable,
        sha256: candidate.sha256,
        ...(canonical ? { canonicalMetadataProtocol: 1 } : {}),
    };
}
/** 仅宿主环境可显式启用，默认使用原 Node。 */
export function configuredPrivateWindowsRuntime(guardRoot, explicit) {
    const flag = process.env.YUNZAI_GUARD_PRIVATE_NODE;
    if (explicit === undefined && (flag === undefined || flag === "" || flag === "0"))
        return undefined;
    if (explicit === undefined && flag !== "1")
        throw new Error(M.sandbox.privateEnv);
    return verifyPrivateWindowsRuntime(explicit ?? {
        directory: path.join(guardRoot, privateWindowsCanonicalRuntimeCandidate.directory),
        sha256: privateWindowsCanonicalRuntimeCandidate.sha256,
    });
}
/** Windows 环境变量名不区分大小写，不修改宿主环境对象。 */
export function prependWindowsRuntimePath(env, runtimeDirectory) {
    const entries = Object.entries(env);
    const paths = entries.filter(([key]) => key.toLowerCase() === "path");
    const preferred = paths.find(([key]) => key === "PATH") ?? paths[0];
    const result = Object.fromEntries(entries.filter(([key]) => key.toLowerCase() !== "path"));
    result.PATH = runtimeDirectory + (preferred?.[1] ? `;${preferred[1]}` : "");
    return result;
}
//# sourceMappingURL=windows-runtime.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("sandbox/windows-runtime.ts", { privateWindowsRuntimeCandidate, privateWindowsCanonicalRuntimeCandidate, verifyPrivateWindowsRuntime, configuredPrivateWindowsRuntime, prependWindowsRuntimePath })
