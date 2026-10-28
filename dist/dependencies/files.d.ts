/** 依赖只接受普通文件和真实目录，避免链接改变核验目标。 */
export declare function readFile(file: string, maximum?: number): Buffer;
/** 计算 SHA-256 十六进制摘要。 */
export declare function hash(bytes: Uint8Array): string;
/** 校验文件摘要，不符时抛错；通过时返回文件路径。 */
export declare function verifyFile(file: string, expected: string): string;
/** 逐级创建目录，拒绝经过符号链接或非目录的路径。 */
export declare function createDirectory(directory: string): void;
