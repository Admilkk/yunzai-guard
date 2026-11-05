export interface CommandGuardOptions {
    roots: string[];
    deny(operation: string, target: string): never;
}
/** 仅拒绝能够明确识别的 Guard 写入目标，解析不足与进程类型不构成拒绝理由。 */
export declare function createCommandGuard(options: CommandGuardOptions): (operation: string, args: readonly unknown[]) => void;
