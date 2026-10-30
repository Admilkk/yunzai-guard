export declare const maxSettingsBytes: number;
/** 安装目录及其父目录可信；拒绝受管根目录内的路径别名。 */
export declare function directory(root: string, parts: string[], create: boolean): string;
/** 读取配置文件，不存在时返回 undefined。 */
export declare function readConfig(filename: string): Buffer | undefined;
export interface UserConfig {
    /** settings.yaml 路径，写入目标。 */
    filename: string;
    /** settings.yaml 的原始字节；尚未转换为 YAML 时为 undefined。 */
    original?: Buffer;
    /** settings.yaml 原文，写入时据此保留注释。 */
    text?: string;
    /** 尚未转换时读取的旧版 settings.json；写入后它会被改写为镜像，需备份并检查并发修改。 */
    legacy?: {
        filename: string;
        bytes: Buffer;
    };
    value: Record<string, unknown>;
}
/** 本次修改实际读取的文件及其原始字节，用于备份。 */
export declare function configOrigin(config: UserConfig): {
    filename: string;
    bytes: Buffer;
} | undefined;
/** 确认读取过的配置文件在提交前都未被他人修改。 */
export declare function configUnchanged(config: UserConfig): void;
/** 读取并校验用户配置：优先 settings.yaml，只有旧版 settings.json 时读取它，写入时转换为 YAML。 */
export declare function readUserConfig(state: string): UserConfig;
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
/** 同步旧版本回退用的 settings.json；失败时由下次宿主启动补齐。 */
export declare function syncLegacy(state: string, value: Record<string, unknown>): void;
