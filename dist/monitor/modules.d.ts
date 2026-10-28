import type { EmitEvent } from "../shared/types.js";
import type { HookWatch } from "./watch.js";
/** 观察配额只限制保留的登记和报告，不限制恶意 JS 的执行。 */
export declare const MODULE_AUDIT_LIMITS: Readonly<{
    installations: 32;
    modules: 2048;
    graphNodes: 8192;
    resolutionEdges: 32768;
    properties: 256;
    moduleSlots: 512;
    inspectionsPerModule: 4096;
    slots: 16384;
    reportsPerCheck: 128;
    coverageReports: 32;
    sourceBytes: number;
}>;
export interface ModuleAuditOptions {
    root: string;
    guardRoot: string;
    emit: EmitEvent;
    contextPlugin?: () => string | undefined;
    originalFunction?: (value: Function) => Function;
    intervalMs?: number;
    watch?: HookWatch;
}
export interface ModuleAudit {
    instrument(url: string, format: string | undefined, source: unknown): string | undefined;
    resolve(parentURL: string | undefined, resolvedURL: string): void;
    check(plugin?: string): void;
    close(): void;
}
/** 由追加的 ESM 代码调用；观察失败不能影响业务模块求值。 */
export declare function observeModule(id: string, url: string, namespace: unknown): void;
/**
 * 观察导出函数及其自有静态或原型函数描述符。
 * 不包装、冻结、恢复或阻止插件修改；不处理 CJS 及对象图。
 */
export declare function installModuleAudit(options: ModuleAuditOptions): ModuleAudit;
