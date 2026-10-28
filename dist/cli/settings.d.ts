export declare const maxSettingsBytes: number;
/** 安装目录及其父目录可信；拒绝受管根目录内的路径别名。 */
export declare function directory(root: string, parts: string[], create: boolean): string;
/** 读取配置文件，不存在时返回 undefined。 */
export declare function readConfig(filename: string): Buffer | undefined;
/** 解析配置字节，空内容视为空对象。 */
export declare function parseConfig(bytes?: Buffer): Record<string, unknown>;
/** 确认配置文件自读取后未被修改。 */
export declare function unchanged(filename: string, expected?: Buffer): void;
export interface OwnedFile {
    name: string;
    dev: number;
    ino: number;
}
/** 独占创建文件并记录其身份，供之后安全删除。 */
export declare function createFile(filename: string, content: string | Buffer): OwnedFile;
/** 仅在身份未变时删除自己创建的文件。 */
export declare function removeOwned(file: OwnedFile): void;
