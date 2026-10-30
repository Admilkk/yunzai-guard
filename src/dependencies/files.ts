import fs from "node:fs"
import path from "node:path"
import { M } from "../shared/messages.js"
import { hashFile } from "../shared/hash.js"
import { isOrdinaryFile } from "../shared/files.js"

/** 依赖只接受普通文件和真实目录，避免链接改变核验目标。 */
function checkedFile(file: string, maximum: number): string {
  const absolute = path.resolve(file)
  for (let cursor = path.dirname(absolute); ; cursor = path.dirname(cursor)) {
    const stat = fs.lstatSync(cursor)
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(M.dependencies.realDirectories)
    if (cursor === path.dirname(cursor)) break
  }
  const stat = fs.lstatSync(absolute)
  if (!isOrdinaryFile(stat, maximum)) throw new Error(M.dependencies.ordinaryFile)
  return absolute
}

/** 校验依赖路径与大小后读取文件，供小型清单解析使用。 */
export function readFile(file: string, maximum = 256 * 1024 * 1024): Buffer {
  return fs.readFileSync(checkedFile(file, maximum))
}

/** 分块校验依赖摘要，保留路径与大小限制；通过时返回原文件路径。 */
export function verifyFile(file: string, expected: string): string {
  if (
    !/^[a-f0-9]{64}$/.test(expected) ||
    hashFile(checkedFile(file, 256 * 1024 * 1024)) !== expected
  )
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
