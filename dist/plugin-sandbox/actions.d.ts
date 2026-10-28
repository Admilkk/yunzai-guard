import type { SandboxAction, SandboxSource, SandboxEvent } from "./types.js";
/** 引擎输出不可信；插件身份和授权仅由调用方提供。 */
export declare function validateSandboxActions(value: unknown, plugin: SandboxSource): SandboxAction[];
/** 把消息事件转为传入受限脚本的有界快照。 */
export declare function sandboxEvent(event: Record<string, unknown>): SandboxEvent;
