import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { readFile, verifyFile } from "./files.js"
import { M } from "../shared/messages.js"
import { atLeastVersion } from "../shared/version.js"

const checked = new Set<string>()

/** 试运行 bubblewrap，确认在当前网络模式下可用，结果按参数缓存。 */
function probe(executable: string, network: "none" | "host"): string {
  const key = `${executable}\0${network}`
  if (checked.has(key)) return executable
  const version = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 3000 })
  if (version.status !== 0 || !/bubblewrap\s+\d+\.\d+/.test(version.stdout))
    throw new Error(M.dependencies.bwrapVersion)
  const result = spawnSync(
    executable,
    [
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      ...(network === "none" ? ["--unshare-net"] : []),
      "--die-with-parent",
      "--ro-bind",
      "/",
      "/",
      "--proc",
      "/proc",
      "--",
      "/bin/true",
    ],
    { encoding: "utf8", timeout: 5000 },
  )
  if (result.error || result.status !== 0)
    throw new Error(
      M.dependencies.bwrapNamespaces(
        String(result.stderr ?? result.error?.message ?? "")
          .trim()
          .slice(0, 1000),
      ),
    )
  checked.add(key)
  return executable
}

/** 校验系统 bubblewrap 为 root 拥有的普通文件。 */
function systemFile(candidate: string, network: "none" | "host"): string {
  const file = fs.realpathSync(candidate)
  for (let cursor = file; ; cursor = path.dirname(cursor)) {
    const stat = fs.statSync(cursor)
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error(M.dependencies.bwrapOwner)
    if (cursor === path.dirname(cursor)) break
  }
  fs.accessSync(file, fs.constants.X_OK)
  return probe(file, network)
}

/** 优先使用系统包的安全策略；缺失时使用随插件提供的无 setuid 静态程序。 */
export function prepareBubblewrap(
  repository: string,
  requested?: string,
  network: "none" | "host" = "none",
): string {
  if (process.platform !== "linux") throw new Error(M.dependencies.bwrapLinuxOnly)
  if (requested) {
    if (!path.isAbsolute(requested)) throw new Error(M.dependencies.bwrapPathAbsolute)
    try {
      return systemFile(requested, network)
    } catch (error) {
      throw new Error(M.dependencies.bwrapConfigured((error as Error).message))
    }
  }
  const errors: string[] = []
  for (const candidate of ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"]) {
    if (!fs.existsSync(candidate)) continue
    try {
      return systemFile(candidate, network)
    } catch (error) {
      errors.push((error as Error).message)
    }
  }
  try {
    if (process.arch !== "x64") throw new Error(M.dependencies.bwrapX64Only)
    const root = path.join(repository, "native/bubblewrap")
    const manifest = JSON.parse(readFile(path.join(root, "manifest.json"), 16384).toString("utf8"))
    if (
      manifest.schemaVersion !== 1 ||
      manifest.platform !== "linux" ||
      manifest.architecture !== "x64" ||
      manifest.file !== "bin/linux-x64/bwrap" ||
      !atLeastVersion(manifest.version, [0, 12, 0])
    )
      throw new Error(M.dependencies.bwrapManifest)
    const file = verifyFile(path.join(root, manifest.file), manifest.sha256)
    const mode = fs.statSync(file).mode & 0o7777
    if ((mode & 0o6000) !== 0) throw new Error(M.dependencies.bwrapSetuid)
    if ((mode & 0o111) === 0) fs.chmodSync(file, 0o755)
    return probe(file, network)
  } catch (error) {
    errors.push((error as Error).message)
  }
  throw new Error(M.dependencies.bwrapUnavailable([...new Set(errors)].join("; ")))
}
