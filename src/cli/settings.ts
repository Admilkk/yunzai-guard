import fs from "node:fs"
import path from "node:path"
import { parseSettings } from "../config/index.js"
import { M } from "../shared/messages.js"

export const maxSettingsBytes = 1024 * 1024

/** 判断错误是否为文件不存在。 */
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT"
}

/** 安装目录及其父目录可信；拒绝受管根目录内的路径别名。 */
export function directory(root: string, parts: string[], create: boolean): string {
  let current = path.resolve(root)
  for (const part of ["", ...parts]) {
    if (part) current = path.join(current, part)
    if (create && part) {
      try {
        fs.mkdirSync(current, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
    }
    try {
      const stat = fs.lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(M.cli.pathNotDirectory(current))
    } catch (error) {
      if (part && !create && missing(error)) continue
      throw error
    }
  }
  return current
}

/** 读取配置文件，不存在时返回 undefined。 */
export function readConfig(filename: string): Buffer | undefined {
  try {
    const stat = fs.lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxSettingsBytes)
      throw new Error(M.cli.settingsFile)
    const value = fs.readFileSync(filename)
    if (value.length > maxSettingsBytes) throw new Error(M.cli.settingsOversize)
    return value
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

/** 解析配置字节，空内容视为空对象。 */
export function parseConfig(bytes?: Buffer): Record<string, unknown> {
  if (!bytes) return {}
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  if (text.charCodeAt(0) === 0xfeff) throw new Error(M.cli.settingsEncoding)
  const value: unknown = JSON.parse(text)
  parseSettings(value)
  return value as Record<string, unknown>
}

/** 确认配置文件自读取后未被修改。 */
export function unchanged(filename: string, expected?: Buffer): void {
  const actual = readConfig(filename)
  if (actual === undefined ? expected !== undefined : !expected || !actual.equals(expected))
    throw new Error(M.cli.settingsChanged)
}

export interface OwnedFile {
  name: string
  dev: number
  ino: number
}

/** 独占创建文件并记录其身份，供之后安全删除。 */
export function createFile(filename: string, content: string | Buffer): OwnedFile {
  const fd = fs.openSync(filename, "wx", 0o600)
  const stat = fs.fstatSync(fd)
  const owned = { name: filename, dev: stat.dev, ino: stat.ino }
  try {
    fs.writeFileSync(fd, content)
    fs.fsyncSync(fd)
  } catch (error) {
    fs.closeSync(fd)
    removeOwned(owned)
    throw error
  }
  fs.closeSync(fd)
  return owned
}

/** 仅在身份未变时删除自己创建的文件。 */
export function removeOwned(file: OwnedFile): void {
  try {
    const current = fs.lstatSync(file.name)
    if (current.dev === file.dev && current.ino === file.ino && !current.isSymbolicLink())
      fs.unlinkSync(file.name)
  } catch (error) {
    if (!missing(error)) throw error
  }
}
