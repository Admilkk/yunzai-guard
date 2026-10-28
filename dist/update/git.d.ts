/** 编译好的发布分支；只有它可以直接用 git 更新，main 源码分支还需要重新编译。 */
export declare const releaseBranch = "release";
/** 同步执行一条 git 命令并返回输出；失败时抛出。 */
export declare function gitSync(cwd: string, args: string[]): string;
/** 异步执行一条 git 命令；失败时抛出带 git 输出的错误。 */
export declare function git(cwd: string, args: string[]): Promise<string>;
/** 读取 Git 安装的分支；不是 Git 仓库或读取失败时返回 undefined。 */
export declare function gitBranch(cwd: string): string | undefined;
/** 读取某个提交里的插件版本号。 */
export declare function versionAt(cwd: string, revision: string): string | undefined;
/** 拉取远端发布分支的最新提交，返回提交号与其中的版本号；不改动工作区。 */
export declare function fetchRelease(cwd: string, expected: string, force: boolean): Promise<{
    commit: string;
    version: string;
}>;
