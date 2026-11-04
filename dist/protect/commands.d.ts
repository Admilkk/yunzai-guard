import type { EmitEvent, GuardSettings } from "../shared/types.js";
export interface CommandGuardOptions {
    roots: string[];
    readRoots: string[];
    settings: GuardSettings;
    deny(operation: string, target: string): never;
    emit: EmitEvent;
    originPlugin(): string | undefined;
}
/** 固定文件保护先于业务策略；脚本只在没有显式规则时默认拒绝。 */
export declare function createCommandGuard(options: CommandGuardOptions): (operation: string, args: readonly unknown[]) => void;
