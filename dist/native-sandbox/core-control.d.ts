export declare class NativeCoreControlDenied extends Error {
    readonly code = "NATIVE_CORE_DENIED";
}
/** 权限来自当前宿主请求，不能信任插件提供的 isMaster 字段。 */
export declare function requireNativeRestartCapability(args: unknown[], requestType: string | undefined, event: Record<string, unknown> | undefined, alreadyRequested: boolean, permitted: boolean): void;
