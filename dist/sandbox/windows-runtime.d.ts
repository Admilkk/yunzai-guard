/** 保留早期管道候选供显式选择，不授予元数据能力。 */
export declare const privateWindowsRuntimeCandidate: Readonly<{
    directory: ".cache/private-node/v24.22.1-appcontainer-win-x64/runtime";
    nodeVersion: "24.22.1";
    modules: "137";
    sha256: "ed7ecd315bab189c03fd7d6c9315131ee680773a461cc4f0c6ad7b822d252736";
    buildManifestSha256: "e26d923e32948e4b5d451484f5511abeff29b18d643aadc2dc44612db221dcc0";
}>;
/** 仅配合 Guard 受控 Windows 路径与子进程启动语义使用。 */
export declare const privateWindowsCanonicalRuntimeCandidate: Readonly<{
    directory: ".cache/private-node/v24.22.1-appcontainer-canonical-v2-final-win-x64/runtime";
    nodeVersion: "24.22.1";
    modules: "137";
    sha256: "781b7cf11f82c37bd34766744cfff805b3c1c24db560b6514e5f1ab7fa068c21";
    buildManifestSha256: "573a989fcf1d2e5f791f3f806a837432666eab9b2022607f21c94d8053c25008";
    osVerificationSha256: "98ff99fb613e73f2360425752249213d2d06c08d3e5c933ea646822b09d3d735";
}>;
export interface PrivateWindowsRuntimeSelection {
    directory: string;
    sha256: string;
}
export interface VerifiedPrivateWindowsRuntime {
    executable: string;
    sha256: string;
    /** 仅为单独接受的元数据运行时及其描述清单提供。 */
    canonicalMetadataProtocol?: 1;
}
interface RuntimeHost {
    platform: string;
    arch: string;
    versions: {
        node: string;
        modules?: string;
    };
}
/** 仅接受可信宿主选择，不接受插件提供的路径或回退到不同 ABI。 */
export declare function verifyPrivateWindowsRuntime(selection: PrivateWindowsRuntimeSelection, host?: RuntimeHost): VerifiedPrivateWindowsRuntime;
/** 仅宿主环境可显式启用，默认使用原 Node。 */
export declare function configuredPrivateWindowsRuntime(guardRoot: string, explicit?: PrivateWindowsRuntimeSelection): VerifiedPrivateWindowsRuntime | undefined;
/** Windows 环境变量名不区分大小写，不修改宿主环境对象。 */
export declare function prependWindowsRuntimePath(env: NodeJS.ProcessEnv, runtimeDirectory: string): NodeJS.ProcessEnv;
export {};
