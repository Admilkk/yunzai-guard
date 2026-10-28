import type { EmitEvent, GuardSettings } from "../shared/types.js";
import type { SandboxSource } from "./types.js";
export { validateSandboxActions, sandboxEvent } from "./actions.js";
export declare class SandboxDispatcher {
    #private;
    readonly root: string;
    readonly settings: GuardSettings;
    readonly sources: SandboxSource[];
    readonly emit: EmitEvent;
    readonly log: (id: string, text: string) => void;
    /** 创建受限脚本分派器。 */
    constructor(root: string, settings: GuardSettings, sources: SandboxSource[], emit: EmitEvent, log: (id: string, text: string) => void);
    /** 预热执行器，确认脚本可加载。 */
    ready(): Promise<void>;
    /** 把消息分派给匹配的受限脚本，返回是否已处理。 */
    dispatch(original: Record<string, unknown>): Promise<boolean>;
    /** 关闭分派器与执行器。 */
    close(): Promise<void>;
}
