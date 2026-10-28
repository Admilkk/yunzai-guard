import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { M } from "../shared/messages.js";
const timeoutMs = 120000;
const env = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });
/** 编译好的发布分支；只有它可以直接用 git 更新，main 源码分支还需要重新编译。 */
export const releaseBranch = "release";
/** 同步执行一条 git 命令并返回输出；失败时抛出。 */
export function gitSync(cwd, args) {
    return execFileSync("git", ["-c", "safe.directory=*", ...args], {
        cwd,
        env: env(),
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
}
/** 异步执行一条 git 命令；失败时抛出带 git 输出的错误。 */
export function git(cwd, args) {
    return new Promise((resolve, reject) => execFile("git", ["-c", "safe.directory=*", ...args], { cwd, env: env(), timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => error
        ? reject(new Error(String(stderr).trim() || error.message))
        : resolve(String(stdout).trimEnd())));
}
/** 直接读取 HEAD 获取当前分支，兼容 worktree；查询状态时不启动 Git 子进程。 */
export function gitBranch(cwd) {
    try {
        let directory = path.join(cwd, ".git");
        if (fs.statSync(directory).isFile()) {
            const pointer = fs.readFileSync(directory, "utf8").trim();
            if (!pointer.startsWith("gitdir: "))
                return undefined;
            directory = path.resolve(cwd, pointer.slice(8));
        }
        const head = fs.readFileSync(path.join(directory, "HEAD"), "utf8").trim();
        if (head.startsWith("ref: refs/heads/"))
            return head.slice(16) || undefined;
        return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) ? "HEAD" : undefined;
    }
    catch {
        return undefined;
    }
}
/** 读取某个提交里的插件版本号。 */
export function versionAt(cwd, revision) {
    try {
        const value = JSON.parse(gitSync(cwd, ["show", `${revision}:package.json`]));
        return typeof value.version === "string" ? value.version : undefined;
    }
    catch {
        return undefined;
    }
}
/** 把某个提交的文件导出为 tar 包。 */
export async function exportCommit(cwd, commit, file) {
    await git(cwd, ["archive", "--format=tar", "-o", file, commit]);
}
/** 拉取远端发布分支的最新提交，返回提交号与其中的版本号；不改动工作区。 */
export async function fetchRelease(cwd, expected, force) {
    if (!force) {
        const status = await git(cwd, ["status", "--porcelain", "--untracked-files=no"]);
        if (status)
            throw new Error(M.update.gitDirty);
    }
    await git(cwd, ["fetch", "--quiet", "--depth=1", "origin", releaseBranch]);
    const commit = await git(cwd, ["rev-parse", "FETCH_HEAD"]);
    const version = versionAt(cwd, commit);
    if (version !== expected)
        throw new Error(M.update.gitVersion(expected, version ?? "未知"));
    return { commit, version };
}
//# sourceMappingURL=git.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("update/git.ts", { releaseBranch, gitSync, git, gitBranch, versionAt, exportCommit, fetchRelease })
