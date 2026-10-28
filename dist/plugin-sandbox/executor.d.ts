import type { SandboxEvent, SandboxResult, SandboxSettings, SandboxSource } from "./types.js";
export declare class SandboxExecutor {
    #private;
    /** 在独立 Worker 中执行受限脚本，超时或违规时终止。 */
    execute(plugin: SandboxSource, event: SandboxEvent, settings: SandboxSettings): Promise<SandboxResult>;
    /** 关闭执行器并终止 Worker。 */
    close(): Promise<void>;
}
