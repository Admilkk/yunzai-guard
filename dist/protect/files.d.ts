export interface FileGuardOptions {
    roots: string[];
    /** 仅控制凭据和清单需要保密，源码与业务文件仍可读取。 */
    readRoots?: string[];
    deny(operation: string, target: string): never;
    seal(object: object, key: PropertyKey, value: unknown): void;
    /** 自保护检查通过后的业务观察；抛错按各入口的原有语义交给调用方。 */
    observe?(operation: string, target: unknown, write: boolean, source?: unknown): void;
}
/** 安装后不暴露卸载入口；可信宿主写入位于另一个进程。 */
export declare function installFileGuard(options: FileGuardOptions): void;
