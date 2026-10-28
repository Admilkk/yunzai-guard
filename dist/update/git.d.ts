/** 编译好的发布分支；只有它可以直接用 git 更新，main 源码分支还需要重新编译。 */
export declare const releaseBranch = "release";
/** 同步执行一条 git 命令并返回输出；失败时抛出。 */
export declare function gitSync(cwd: string, args: string[]): string;
/** 异步执行一条 git 命令；失败时抛出带 git 输出的错误。 */
export declare function git(cwd: string, args: string[]): Promise<string>;
/** 直接读取 HEAD 获取当前分支，兼容 worktree；查询状态时不启动 Git 子进程。 */
export declare function gitBranch(cwd: string): string | undefined;
/** 读取某个提交里的插件版本号。 */
export declare function versionAt(cwd: string, revision: string): string | undefined;
/** 把某个提交的文件导出为 tar 包。 */
export declare function exportCommit(cwd: string, commit: string, file: string): Promise<void>;
/** 拉取远端发布分支的最新提交，返回提交号与其中的版本号；不改动工作区。 */
export declare function fetchRelease(cwd: string, expected: string, force: boolean): Promise<{
    commit: string;
    version: string;
}>;
