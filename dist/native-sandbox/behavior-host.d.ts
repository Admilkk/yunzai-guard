import type { GuardEvent, GuardSettings } from "../shared/types.js";
/** 受限进程仅上报 JS 观察结果，不能提供宿主身份或新增权限。 */
export declare function validateNativeBehaviorEvent(settings: GuardSettings, pluginId: string, input: unknown): GuardEvent;
