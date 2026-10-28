import type { FileGuardOptions } from "./files.js";
/** 限制诊断报告的输出目录，禁止写入受保护路径。 */
export declare function installReportGuard(options: Pick<FileGuardOptions, "roots" | "deny" | "seal">): void;
