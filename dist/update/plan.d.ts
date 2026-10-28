/**
 * 更新级别，按影响从小到大：
 * - static：只有控制台前端，替换文件即可
 * - core：控制台服务，在宿主内重新加载，业务不中断
 * - worker：Yunzai 进程内的代码，需要重启业务进程一次
 * - host：宿主外壳或原生程序，需要整个宿主重新启动
 */
export type UpdateLevel = "static" | "core" | "worker" | "host";
export type ComponentRole = "shell" | "worker" | "core" | "static" | "meta";
export interface ComponentManifest {
    schema: 1;
    version: string;
    files: Record<string, {
        sha256: string;
        roles: ComponentRole[];
    }>;
}
export interface UpdatePlan {
    level: UpdateLevel;
    /** 内容变化、新增或删除的文件（相对插件目录）。 */
    changed: string[];
    /** 判定为 host 级别的原因：缺少组件清单时无法比较。 */
    reason?: "manifest-missing";
}
export declare const manifestFile = "dist/components.json";
/** 读取并校验组件清单；缺失或格式不符时返回 undefined。 */
export declare function readManifest(directory: string): ComponentManifest | undefined;
/** 比较新旧组件清单，得出本次更新需要的最低级别。 */
export declare function planUpdate(current: ComponentManifest | undefined, next: ComponentManifest | undefined): UpdatePlan;
/** 比较级别高低。 */
export declare function atLeastLevel(value: UpdateLevel, minimum: UpdateLevel): boolean;
export interface HotSync {
    /** 还原被覆盖与删除的文件。 */
    rollback(): void;
}
/**
 * 逐个文件热替换：只改动清单中变化的文件，其余运行中的文件保持原样。
 * 新文件先写到同目录临时文件再改名覆盖，原文件移到备份目录，失败时全部还原。
 */
export declare function syncFiles(stagedDir: string, pluginDir: string, files: string[], backupDir: string): HotSync;
