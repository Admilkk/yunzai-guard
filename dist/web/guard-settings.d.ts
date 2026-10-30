import type { GuardSettings } from "../shared/types.js";
export interface SettingsDocument {
    path: string;
    /** 可直接编辑的配置对象；文件缺失时以当前生效配置作为起点。 */
    document: Record<string, unknown>;
    normalized?: Record<string, unknown>;
    /** 磁盘原文（settings.yaml，尚未转换时为旧版 settings.json），供“原始配置”页面直接编辑。 */
    text: string;
    source: "file" | "defaults";
    valid: boolean;
    error?: string;
    pendingRestart: boolean;
}
export interface SettingsSaveResult {
    pendingRestart: boolean;
    backup: string | null;
}
/** 返回 Guard 配置文件路径。 */
export declare function guardSettingsPath(stateDir: string): string;
/** 把配置转为可序列化的普通对象。 */
export declare function serializeSettings(settings: GuardSettings): Record<string, unknown>;
/** 判断为非数组的普通对象。 */
export declare function isPlainObject(value: unknown): value is Record<string, unknown>;
/** 读取磁盘上的配置；只有宿主能读这个目录，面板因此也运行在宿主进程。 */
export declare function readSettingsDocument(stateDir: string, active: GuardSettings): SettingsDocument;
export interface SettingsBackup {
    id: string;
    time: number;
    size: number;
}
/** 列出历史配置备份，新的在前。 */
export declare function listSettingsBackups(stateDir: string): SettingsBackup[];
/** 读取一份历史备份；编号只接受备份文件名。YAML 备份同时返回原文，恢复时可保留注释。 */
export declare function readSettingsBackup(stateDir: string, id: string): {
    document: Record<string, unknown>;
    raw?: string;
} | undefined;
/**
 * 校验后原子写入，配置应用由宿主处理。传入 raw 时按原文写入；否则在现有 settings.yaml 上
 * 只改变化的值，保留注释与顺序，并且不新增与默认值相同的项。
 */
export declare function writeSettingsDocument(stateDir: string, active: GuardSettings, value: unknown, raw?: string): SettingsSaveResult;
/** 仅校验不落盘，供页面在保存前提示错误。 */
export declare function validateSettings(value: unknown): GuardSettings;
export interface SandboxScript {
    id: string;
    size: number;
}
/** 返回沙箱脚本目录。 */
export declare function sandboxScriptsDir(stateDir: string): string;
/** 命令沙盒脚本由用户在磁盘放置；面板只检查存在性，避免启用后宿主启动失败。 */
export declare function listSandboxScripts(stateDir: string): SandboxScript[];
/** 校验面板提交的配置文档。 */
export declare function validateSettingsDocument(stateDir: string, value: unknown): GuardSettings;
