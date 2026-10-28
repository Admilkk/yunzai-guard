import { root, stateDir, projectId } from "../shared/identity.js";
export { root, stateDir, projectId };
export declare const settings: import("../shared/types.js").GuardSettings;
export declare const controlPort: number;
export declare const controlPath: string;
export { setTimeout as sleep } from "node:timers/promises";
/** 轮询条件直到为真，超时抛错。 */
export declare function until(predicate: () => unknown | Promise<unknown>, ms?: number): Promise<unknown>;
