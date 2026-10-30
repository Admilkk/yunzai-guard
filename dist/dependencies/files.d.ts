/** 校验依赖路径与大小后读取文件，供小型清单解析使用。 */
export declare function readFile(file: string, maximum?: number): Buffer;
/** 分块校验依赖摘要，保留路径与大小限制；通过时返回原文件路径。 */
export declare function verifyFile(file: string, expected: string): string;
/** 逐级创建目录，拒绝经过符号链接或非目录的路径。 */
export declare function createDirectory(directory: string): void;
