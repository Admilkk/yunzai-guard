import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { M } from "../shared/messages.js"

/** 依赖只接受普通文件和真实目录，避免链接改变核验目标。 */
export function readFile(file: string, maximum = 256 * 1024 * 1024): Buffer {
  const absolute = path.resolve(file)
  for (let cursor = path.dirname(absolute); ; cursor = path.dirname(cursor)) {
    const stat = fs.lstatSync(cursor)
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(M.dependencies.realDirectories)
    if (cursor === path.dirname(cursor)) break
  }
  const stat = fs.lstatSync(absolute)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum)
    throw new Error(M.dependencies.ordinaryFile)
  return fs.readFileSync(absolute)
}

/** 计算 SHA-256 十六进制摘要。 */
export function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** 校验文件摘要，不符时抛错；通过时返回文件路径。 */
export function verifyFile(file: string, expected: string): string {
  if (!/^[a-f0-9]{64}$/.test(expected) || hash(readFile(file)) !== expected)
    throw new Error(M.dependencies.hashMismatch(path.basename(file)))
  return file
}

/** 逐级创建目录，拒绝经过符号链接或非目录的路径。 */
export function createDirectory(directory: string): void {
  const absolute = path.resolve(directory)
  const missing: string[] = []
  let current = absolute
  while (!fs.existsSync(current)) {
    missing.unshift(current)
    current = path.dirname(current)
  }
  for (let cursor = current; ; cursor = path.dirname(cursor)) {
    const stat = fs.lstatSync(cursor)
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(M.dependencies.cacheDirectories)
    if (cursor === path.dirname(cursor)) break
  }
  for (const target of missing) fs.mkdirSync(target, { mode: 0o700 })
}
