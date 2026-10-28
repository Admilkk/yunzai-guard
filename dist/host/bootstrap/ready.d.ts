import type { CoreBot } from "../../shared/types.js";
/** 等待核心发出就绪信号。 */
export declare function waitForBootstrapReady(bot: CoreBot, timeout: number, signal?: AbortSignal): Promise<void>;
