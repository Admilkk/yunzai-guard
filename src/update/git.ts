import { execFile, execFileSync } from "node:child_process"
import { M } from "../shared/messages.js"

const timeoutMs = 120000
const env = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" })

/** 编译好的发布分支；只有它可以直接用 git 更新，main 源码分支还需要重新编译。 */
export const releaseBranch = "release"

/** 同步执行一条 git 命令并返回输出；失败时抛出。 */
export function gitSync(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "safe.directory=*", ...args], {
    cwd,
    env: env(),
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd()
}

/** 异步执行一条 git 命令；失败时抛出带 git 输出的错误。 */
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      "git",
      ["-c", "safe.directory=*", ...args],
      { cwd, env: env(), timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(String(stderr).trim() || error.message))
          : resolve(String(stdout).trimEnd()),
    ),
  )
}

/** 读取 Git 安装的分支；不是 Git 仓库或读取失败时返回 undefined。 */
export function gitBranch(cwd: string): string | undefined {
  try {
    return gitSync(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) || undefined
  } catch {
    return undefined
  }
}

/** 读取某个提交里的插件版本号。 */
export function versionAt(cwd: string, revision: string): string | undefined {
  try {
    const value = JSON.parse(gitSync(cwd, ["show", `${revision}:package.json`])) as {
      version?: unknown
    }
    return typeof value.version === "string" ? value.version : undefined
  } catch {
    return undefined
  }
}

/** 拉取远端发布分支的最新提交，返回提交号与其中的版本号；不改动工作区。 */
export async function fetchRelease(
  cwd: string,
  expected: string,
  force: boolean,
): Promise<{ commit: string; version: string }> {
  if (!force) {
    const status = await git(cwd, ["status", "--porcelain", "--untracked-files=no"])
    if (status) throw new Error(M.update.gitDirty)
  }
  await git(cwd, ["fetch", "--quiet", "--depth=1", "origin", releaseBranch])
  const commit = await git(cwd, ["rev-parse", "FETCH_HEAD"])
  const version = versionAt(cwd, commit)
  if (version !== expected) throw new Error(M.update.gitVersion(expected, version ?? "未知"))
  return { commit, version }
}
