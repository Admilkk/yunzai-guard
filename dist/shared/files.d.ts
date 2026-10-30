import fs from "node:fs";
/**
 * 读取 JSON 文件。文件不存在时返回 undefined；超过大小上限或内容损坏时抛出，
 * 由调用方决定按首次运行处理、视为熔断还是报错。
 */
export declare function readJsonFile(file: string, maxBytes?: number): unknown;
/**
 * 原子写入文本：先写同目录临时文件再改名替换，进程中途退出也不会留下半截文件。
 * 权限 0600，按需创建目录；失败时清理临时文件并抛出。
 */
export declare function writeTextFile(file: string, text: string): void;
/** 原子写入 JSON，见 writeTextFile。 */
export declare function writeJsonFile(file: string, value: unknown, options?: {
    pretty?: boolean;
}): void;
/** 是否为普通文件：不是符号链接且只有一个硬链接，避免链接把读写引向别处；可附加大小上限。 */
export declare function isOrdinaryFile(stat: fs.Stats, maxBytes?: number): boolean;
