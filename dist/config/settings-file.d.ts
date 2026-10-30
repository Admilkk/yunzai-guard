/**
 * 配置文件：
 * - settings.yaml 由用户编辑，只写要改的项，可写注释；Guard 修改时保留注释、顺序与格式。
 * - settings.default.yaml 每次宿主启动按当前版本重写，列出全部配置项、默认值与说明，只作参考。
 * - settings.json 是旧版本使用的格式：首次启动时转换为 settings.yaml，之后作为镜像保留，
 *   供回退到不支持 YAML 的旧版本时读取。
 */
export declare const settingsFiles: Readonly<{
    user: "settings.yaml";
    defaults: "settings.default.yaml";
    legacy: "settings.json";
}>;
export declare const maxSettingsBytes: number;
type Plain = Record<string, unknown>;
export interface SettingsSource {
    file: string;
    format: "yaml" | "json";
    text: string;
}
/** 某个配置路径的注释文本。 */
export declare function settingNote(keys: string[]): string | undefined;
/** 默认配置文件文本：全部配置项、默认值与说明。 */
export declare function defaultSettingsText(defaults: Plain): string;
/** 新建的用户配置文件：只有说明，所有项取默认值。 */
export declare function starterSettingsText(): string;
/**
 * 生成用户配置文本。previous 为原文时保留其注释、顺序与格式，只改变化的值；
 * omitDefaults 为真时不新增与默认值相同的项，避免把当前默认值固定在用户文件里。
 */
export declare function renderSettings(value: Plain, options?: {
    previous?: string;
    defaults?: Plain;
    omitDefaults?: boolean;
}): string;
/** 解析配置文本，YAML 兼容 JSON；空文档视为空对象。 */
export declare function parseSettingsText(text: string, name?: string): Plain;
/** 读取用户配置：优先 settings.yaml，其次旧版 settings.json。 */
export declare function readSettingsSource(stateDir: string): SettingsSource | undefined;
/** 解析读取到的用户配置。 */
export declare function parseSettingsSource(source: SettingsSource): Plain;
/** 写入旧版本回退用的 settings.json 镜像。 */
export declare function writeLegacyMirror(stateDir: string, value: Plain): void;
/** 原子写入用户配置，并同步 settings.json 镜像；镜像失败不影响配置本身。 */
export declare function writeSettingsText(stateDir: string, text: string): void;
/**
 * 宿主启动时整理配置文件：重写默认配置；只有 settings.json 时转换为 settings.yaml（原文件保留为镜像）；
 * 都没有时创建只含说明的 settings.yaml；之后按需刷新镜像。返回需要提示用户的信息。
 * 任何一步失败都不影响随后按原文件读取配置。
 */
export declare function prepareSettingsFiles(stateDir: string, defaults: Plain): string[];
export {};
