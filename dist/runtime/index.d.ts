import { type InstrumentationDisposer } from "../instrumentation/index.js";
import { type RuntimeIdentity } from "./worker-monitor.js";
import type { EmitEvent, GuardSettings } from "../shared/types.js";
import type { WorkerAuditCloseOptions, WorkerAuditCoverage } from "./worker-monitor.js";
import { type HookWatch } from "../monitor/watch.js";
export interface RuntimeHandle {
    identity: RuntimeIdentity;
    ready: Promise<void>;
    instrumentation: InstrumentationDisposer;
    watch: HookWatch;
    prepareAudit(options: WorkerAuditCloseOptions): void;
    auditCoverage(): WorkerAuditCoverage;
}
interface RuntimeOptions {
    settings: GuardSettings;
    identity: RuntimeIdentity;
    manifestPath?: string;
    /** 仅用于模块解析；此文件不授权连接运行时代理。 */
    resolutionManifestPath?: string;
    emit: EmitEvent;
    ready?: Promise<void>;
    contextProvider?: () => string | undefined;
}
/** 共用的同步安装入口，可安全地由 runtime-bootstrap.cjs require。 */
export declare function installRuntime(options: RuntimeOptions): RuntimeHandle;
/** 由 Node 子进程和 Worker 线程的同步预加载器调用。 */
export declare function installInheritedRuntime(): Pick<RuntimeHandle, "identity" | "ready"> | undefined;
export {};
