import type { NativeSandboxSettings, NativeRedisPermissions } from "./types.js";
export declare const nativeRedisReservedPrefixes: readonly string[];
/** Redis 授权使用区分大小写的字面键名或前缀，不接受通用 glob 或正则。 */
export declare function parseNativeRedisPermissions(value?: unknown, location?: string): NativeRedisPermissions;
export declare const protectedNativeCoreConfigFiles: readonly string[];
/** 校验原生沙箱的可写目录。 */
export declare function validateNativeWritablePaths(value?: unknown, location?: string): string[];
/** protectedCoreFiles 为 config/default_config 中的文件名，不是项目相对路径。 */
export declare function validateNativeWritableFiles(value?: unknown, location?: string, protectedCoreFiles?: readonly string[]): string[];
/** 校验原生沙箱的可写文件授权。 */
export declare function validateNativeWriteGrants(paths?: unknown, files?: unknown, location?: string, protectedCoreFiles?: readonly string[]): {
    writablePaths: string[];
    writableFiles: string[];
};
/** 独立解析，避免其他沙箱模式扩大原生插件权限。 */
export declare function parseNativeSandbox(value?: unknown): NativeSandboxSettings;
/** 仅用于内部启动元数据，不增加原路径授权之外的权限。 */
export declare function nativeSharedWritablePaths(settings: NativeSandboxSettings, id: string): string[];
