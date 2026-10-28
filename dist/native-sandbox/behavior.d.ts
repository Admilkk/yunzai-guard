import { type RuntimeIdentity } from "../runtime/worker-monitor.js";
import type { EmitEvent, GuardSettings } from "../shared/types.js";
export interface NativeBehaviorOptions {
    pluginId: string;
    identity: {
        id: string;
        generation: number;
        parentId?: string;
    };
    settings: unknown;
    /** 沿用原生会话传输；父进程须核验身份并重新判定规则。 */
    emit: EmitEvent;
    /** 可信只读别名清单，与运行时 broker 凭据分离。 */
    resolutionManifestPath?: string;
}
export interface NativeBehaviorHandle {
    readonly identity: RuntimeIdentity;
    readonly settings: GuardSettings;
    readonly ready: Promise<void>;
    /** 仅恢复本地包装，系统会话生命周期仍由所有者负责。 */
    dispose(): void;
}
/** 仅复制共用行为规则；原生插件进程不持有真实 Bot 及其目标对象。 */
export declare function nativeBehaviorSettings(value: unknown): GuardSettings;
/**
 * 在已建立的系统隔离内安装，早于任何业务源码导入。
 * 此处仅观察 JS 入口，不能防护同进程的任意代码。
 * Worker 继承私有端口监控，其他子进程仅保留系统限制和
 * 进程创建审计；本组件不使用运行时 broker 清单或 socket。
 */
export declare function installNativeBehavior(options: NativeBehaviorOptions): NativeBehaviorHandle;
