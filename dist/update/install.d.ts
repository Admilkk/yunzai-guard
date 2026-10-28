import { type ReleaseInfo } from "./release.js";
export interface StagedRelease {
    version: string;
    /** 已解压并校验的包目录；Git 安装时为插件目录本身。 */
    directory: string;
    /** Git 安装：要切换到的提交。 */
    commit?: string;
}
export interface SwapHandle {
    /** 还原到替换前的文件。 */
    rollback(): void;
    /** 放弃回退能力，清理暂存文件；上一版本保留在 previous 目录。 */
    commit(): void;
}
/** 返回当前平台的发布包名；不支持的平台返回 undefined。 */
export declare function assetName(version: string, platform?: NodeJS.Platform, arch?: string): string | undefined;
/** 解析 SHA256SUMS.txt 中指定文件的摘要。 */
export declare function checksumFor(text: string, name: string): string | undefined;
/** 取得更新工作目录，并保证其位于插件目录内以便原子重命名。 */
export declare function workPaths(pluginDir: string): {
    base: string;
    download: string;
    staged: string;
    previous: string;
};
/** 下载、校验并解压发布包到暂存目录；不触碰正在运行的文件。 */
export declare function stageRelease(release: ReleaseInfo, pluginDir: string, currentVersion: string): Promise<StagedRelease>;
/** 用暂存包替换插件文件；任何一步失败都还原已完成的步骤。 */
export declare function swapPackage(staged: StagedRelease, pluginDir: string): SwapHandle;
/** 清理更新工作目录。 */
export declare function clearWork(pluginDir: string): void;
