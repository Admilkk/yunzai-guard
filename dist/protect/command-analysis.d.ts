export interface CommandTarget {
    path: string;
    /** 保留链接后的 .. 等原生路径语义；path 仅用于展示。 */
    raw?: string;
    access: "write" | "read";
    ancestors?: boolean;
}
export interface CommandAnalysis {
    script: boolean;
    targets: CommandTarget[];
    cwd: string;
    executable: string;
    /** 无法在预算内完整检查，不静默采用截断后的结果。 */
    limited?: boolean;
}
/** 提取可确定的执行与文件目标，不把静态分析当作系统文件权限边界。 */
export declare function analyzeCommand(operation: string, input: readonly unknown[]): CommandAnalysis;
