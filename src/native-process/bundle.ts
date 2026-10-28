import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { hashFile } from "../shared/hash.js"
import type { NativeIdentityOptions } from "./protocol.js"
import { fail, object, keys, integer, parseNativeIdentityJson } from "./validation.js"

export { hashFile } from "../shared/hash.js"

/** 定位并校验当前平台的原生身份辅助程序。 */
export function resolveBundle(options: NativeIdentityOptions): {
  root: string
  executable: string
} {
  if (!["win32", "linux"].includes(process.platform) || process.arch !== "x64")
    fail("UNSUPPORTED_PLATFORM_OR_ARCH", "refused-before-action")
  const root = fs.realpathSync.native(
    options.bundleRoot ?? fileURLToPath(new URL("../../native/process-identity", import.meta.url)),
  )
  const regular = (relative: string): string => {
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative.split(/[\\/]/).some(part => !part || part === ".." || part === ".")
    )
      fail("STATE_OR_REQUEST_INVALID")
    let cursor = root
    for (const part of relative.split(/[\\/]/)) {
      cursor = path.join(cursor, part)
      if (fs.lstatSync(cursor).isSymbolicLink()) fail("ACCESS_DENIED")
    }
    if (
      !fs.lstatSync(cursor).isFile() ||
      !fs.realpathSync.native(cursor).startsWith(root + path.sep)
    )
      fail("ACCESS_DENIED")
    return cursor
  }
  const manifestFile = regular("manifest.json")
  if (fs.statSync(manifestFile).size > 1024 * 1024) fail("FRAME_OR_SCOPE_LIMIT")
  // 构建元数据仅作数据，不执行清单中的源码或编译器。
  const manifest = object(parseNativeIdentityJson(fs.readFileSync(manifestFile, "utf8")))
  keys(manifest, ["schemaVersion", "protocol", "profileSet", "sources", "artifacts", "builds"])
  if (
    manifest.schemaVersion !== 1 ||
    manifest.protocol !== 1 ||
    manifest.profileSet !== "node24.22.1-v1" ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length > 8 ||
    !Array.isArray(manifest.builds)
  )
    fail("UNSUPPORTED_NODE_PROFILE")
  const sources = object(manifest.sources)
  if (!Object.keys(sources).length || Object.keys(sources).length > 32) fail()
  for (const [name, expected] of Object.entries(sources))
    if (
      typeof expected !== "string" ||
      !/^[a-f0-9]{64}$/.test(expected) ||
      hashFile(regular(name)) !== expected
    )
      fail("UNSUPPORTED_NODE_PROFILE")
  const found = manifest.artifacts.filter(value => {
    const item = object(value)
    return item.platform === process.platform && item.architecture === process.arch
  })
  if (found.length !== 1) fail("UNSUPPORTED_PLATFORM_OR_ARCH")
  const item = object(found[0])
  keys(item, ["platform", "architecture", "file", "sha256", "bytes", "format"])
  if (
    typeof item.file !== "string" ||
    !item.file.startsWith("bin/") ||
    typeof item.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.sha256) ||
    item.format !== (process.platform === "win32" ? "pe-framework" : "elf-static")
  )
    fail()
  const executable = regular(item.file)
  if (fs.statSync(executable).size !== integer(item.bytes) || hashFile(executable) !== item.sha256)
    fail("UNSUPPORTED_NODE_PROFILE")
  if (process.platform === "linux") fs.accessSync(executable, fs.constants.X_OK)
  return { root, executable }
}
