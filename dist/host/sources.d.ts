import type { GuardSettings } from "../shared/types.js";
export interface PluginSource {
    plugin: string;
    git: boolean;
    remote?: string;
    branch?: string;
    commit?: string;
    /** 工作区中已修改的受跟踪文件数。 */
    dirty?: number;
    dirtyFiles?: string[];
    scannedAt: number;
    error?: string;
}
export interface SourceChange {
    plugin: string;
    type: "commit" | "dirty" | "remote";
    text: string;
}
interface SourceOptions {
    pluginsDir: string;
    stateDir: string;
    settings: () => GuardSettings["sources"];
    onChange: (change: SourceChange) => void;
}
/** 去掉远端地址中的账号口令，避免展示或记录凭据。 */
export declare function cleanRemote(value: string): string;
/**
 * 插件来源校验：定期读取 plugins 下各 Git 插件的远端、提交与工作区状态，
 * 与上次记录比较，发现被改动或来源变化时通知。只读，不执行插件代码。
 */
export declare class SourceWatch {
    #private;
    /** 读取上次保存的来源记录。 */
    constructor(options: SourceOptions);
    /** 最近一次扫描结果。 */
    list(): PluginSource[];
    /** 开始周期扫描。 */
    start(): void;
    /** 停止周期扫描。 */
    stop(): void;
    /** 立即扫描；并发调用共用同一次扫描。 */
    scan(): Promise<PluginSource[]>;
}
export {};
