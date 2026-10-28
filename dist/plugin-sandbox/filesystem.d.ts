import type { SandboxSettings, SandboxSource } from "./types.js";
/** 读取已启用受限脚本的源码。 */
export declare function loadSandboxSources(root: string, settings: SandboxSettings): SandboxSource[];
/** 校验脚本文件名。 */
export declare function sandboxFilename(name: unknown): asserts name is string;
/** 解析受限脚本可写文件的目标路径，禁止越出插件目录。 */
export declare function sandboxWriteTarget(root: string, id: string, file: string, create?: boolean): string;
/** 为受限脚本写入文本文件。 */
export declare function writeSandboxText(root: string, id: string, file: string, text: string): void;
