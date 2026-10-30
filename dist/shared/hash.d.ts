/** 计算数据的 SHA-256 摘要，返回小写十六进制。 */
export declare function sha256(data: string | Uint8Array): string;
/**
 * 分块计算文件的 SHA-256 摘要，读取缓冲区固定为 64 KiB。
 * @param file 要校验的文件路径；路径与文件类型由调用方校验。
 * @returns 小写十六进制摘要。
 */
export declare function hashFile(file: string): string;
