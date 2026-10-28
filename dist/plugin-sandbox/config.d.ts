import type { SandboxSettings } from "./types.js";
/** 统一规范新旧输入；声明冲突时不能静默选择执行模式。 */
export declare function parsePluginSandbox(newValue?: unknown, legacyValue?: unknown): SandboxSettings;
