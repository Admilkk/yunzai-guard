import type { CoreBot } from "../../shared/types.js";
export type ExitHookRunner = (reason: string, budget: number) => Promise<unknown>;
export type ExitHookSource = {
    exitEvent?: CoreBot["exitEvent"];
    rawListeners?: (event: string) => Function[];
};
/** 取得核心的退出钩子，不存在时返回 undefined。 */
export declare function resolveExitHook(bot: ExitHookSource): ExitHookRunner | undefined;
/** 返回缺少退出钩子时的说明。 */
export declare function describeMissingExitHook(): string;
