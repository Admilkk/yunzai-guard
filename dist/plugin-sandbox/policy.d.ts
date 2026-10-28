import type { GuardEvent, GuardSettings } from "../shared/types.js";
import type { SandboxPlugin } from "./types.js";
/** 全局约束先于逐插件规则；旧事件名称仅作输入别名。 */
export declare function sandboxDecision(settings: GuardSettings, plugin: SandboxPlugin, event: GuardEvent): import("../config/policy.js").PolicyDecision;
