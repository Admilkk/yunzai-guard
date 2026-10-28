import type { EmitEvent, GuardSettings } from "../shared/types.js";
import { type NodeLaunchContext } from "../runtime/launch.js";
type ContextProvider = () => string | undefined;
export interface InstrumentationDisposer {
    (): void;
    /** 供 fs 自保护收口转交的业务文件观察。 */
    observeFile: (operation: string, target: unknown, write: boolean, source?: unknown) => void;
    targets: () => Record<string, unknown>;
    checkIntegrity: () => void;
    protect: (seal: (object: object, key: PropertyKey, value: unknown, label: string) => void) => void;
}
/**
 * 在 app.js 前安装，覆盖 JS 内置调用点及同步后的 ESM 绑定。
 * 原生代码、此前捕获的引用和外部程序不在此钩子的保护范围内。
 */
export declare function installInstrumentation(settings: GuardSettings, emit: EmitEvent, contextProvider?: ContextProvider, launchContext?: NodeLaunchContext): InstrumentationDisposer;
export {};
