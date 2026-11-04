import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { types } from "node:util"
import {
  apply,
  newMap,
  mapSet,
  mapGet,
  mapDelete,
  arrayEach,
  arrayPush,
  numberIsInteger,
  stringStartsWith,
  stringEndsWith,
  stringSlice,
  stringLower,
  stringIndexOf,
  objectDescriptor,
  objectPrototype,
  objectDefine,
  regexpTest,
} from "./intrinsics.js"
import { M } from "../shared/messages.js"

const realpath = fs.realpathSync.native
const readlink = fs.readlinkSync
const fstat = fs.fstatSync
const { resolve, relative, isAbsolute, join, dirname, basename, parse } = path
const separator = path.sep
const platform = process.platform
const urlPath = fileURLToPath
const isBytes = types.isUint8Array
const Bytes = Uint8Array
const setBytes = Uint8Array.prototype.set
const byteLength = objectDescriptor(objectPrototype(Uint8Array.prototype), "length")!.get!
const PathError = TypeError
const cwd = process.cwd.bind(process)
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const decode = decoder.decode.bind(decoder)
const looseDecoder = new TextDecoder("utf-8", { ignoreBOM: true })
const decodeLoose = looseDecoder.decode.bind(looseDecoder)
const encoder = new TextEncoder()
const encode = encoder.encode.bind(encoder)
function windowsSeparators(value: string): string {
  let output = ""
  for (let index = 0; index < value.length; index++)
    output += value[index] === "/" ? "\\" : value[index]
  return output
}

/** 固定绝对前缀，但保留交给文件系统处理的链接与 .. 顺序。 */
function absoluteName(value: string): string {
  if (isAbsolute(value)) return value
  const directory = cwd()
  if (platform === "win32" && regexpTest(/^[a-z]:/i, value)) {
    const drive = stringSlice(value, 0, 2)
    const base =
      stringLower(stringSlice(directory, 0, 2)) === stringLower(drive)
        ? directory
        : resolve(`${drive}.`)
    return `${base}${separator}${stringSlice(value, 2)}`
  }
  return `${directory}${separator}${value}`
}

/** Win32 普通路径会折叠尾点/空格；ADS 也属于同一个受保护文件。 */
function windowsAlias(value: string): string {
  const text = windowsSeparators(value)
  const literal = stringStartsWith(text, "\\\\?\\") || stringStartsWith(text, "\\\\.\\")
  const root = parse(text).root
  let output = root
  let start = root.length
  for (let index = start; index <= text.length; index++) {
    if (index !== text.length && text[index] !== "\\") continue
    let part = stringSlice(text, start, index)
    const stream = stringIndexOf(part, ":")
    if (stream >= 0) part = stringSlice(part, 0, stream)
    if (!literal && part !== "." && part !== "..") {
      let end = part.length
      while (end > 0 && (part[end - 1] === "." || part[end - 1] === " ")) end--
      part = stringSlice(part, 0, end)
    }
    if (part) output += `${output && !stringEndsWith(output, "\\") ? "\\" : ""}${part}`
    start = index + 1
  }
  return output
}
/** Windows 下去掉设备前缀并转为小写，便于比较。 */
const normalize = (value: string): string => {
  if (platform !== "win32") return value
  const lower = stringLower(value)
  if (stringStartsWith(lower, "\\\\?\\unc\\")) value = `\\\\${stringSlice(value, 8)}`
  else if (stringStartsWith(value, "\\\\?\\") || stringStartsWith(value, "\\\\.\\"))
    value = stringSlice(value, 4)
  return stringLower(value)
}

/** 判断 value 是否位于 root 内（含 root 本身）。 */
export function within(root: string, value: string): boolean {
  const name = relative(root, value)
  return !name || (!isAbsolute(name) && name !== ".." && !stringStartsWith(name, `..${separator}`))
}

/** 仅使用捕获的只读入口，避免包装器递归调用。 */
export class Paths {
  readonly #roots: string[]
  readonly #fds = newMap<number, { name: string; dev: number; ino: number }>()
  readonly #deny: (operation: string, target: string) => never

  /** 登记受保护根目录。 */
  constructor(roots: string[], deny: (operation: string, target: string) => never) {
    this.#deny = deny
    this.#roots = []
    arrayEach(roots, root => {
      const lexical = resolve(root)
      arrayPush(this.#roots, normalize(lexical))
      arrayPush(this.#roots, normalize(this.#canonical(lexical)))
    })
  }

  /** Node 也接受 Uint8Array 和 URL-like，检查与调用必须使用同一份路径。 */
  snapshot(value: unknown, operation: string, readOnly = false, absolute = true): unknown {
    if (typeof value === "string")
      return absolute && value && !isAbsolute(value) ? absoluteName(value) : value
    if (isBytes(value)) {
      const copy = new Bytes(value)
      try {
        return this.snapshot(decode(copy), operation, readOnly, absolute)
      } catch {
        if (!readOnly) this.#deny(operation, "non-utf8-path")
        const text = decodeLoose(copy)
        if (!absolute || !text || isAbsolute(text)) return copy
        const prefix = encode(`${cwd()}${separator}`)
        const offset = apply(byteLength, prefix, [])
        const full = new Bytes(offset + apply(byteLength, copy, []))
        apply(setBytes, full, [prefix])
        apply(setBytes, full, [copy, offset])
        return full
      }
    }
    if (value && typeof value === "object") {
      const name = urlPath(value as URL)
      if (typeof name === "string") return this.snapshot(name, operation, readOnly, absolute)
      const failure = new PathError(M.protect.pathType)
      objectDefine(failure, "code", { value: "ERR_INVALID_ARG_TYPE" })
      throw failure
    }
    return value
  }

  /** 把路径解析为规范化的真实路径。 */
  #canonical(value: string | Uint8Array): string {
    if (typeof value !== "string") {
      try {
        return realpath(value as Buffer)
      } catch {
        value = decodeLoose(value)
      }
    }
    let cursor = value
    const suffix: string[] = []
    for (;;) {
      try {
        let resolved = realpath(cursor)
        for (let index = suffix.length - 1; index >= 0; index--)
          resolved = join(resolved, suffix[index])
        return resolved
      } catch {
        const parent = dirname(cursor)
        if (parent === cursor) return value
        arrayPush(suffix, basename(cursor))
        cursor = parent
      }
    }
  }

  /** 先解析每个已存在组件的链接，再处理 ..，不预先折叠物理路径。 */
  #physical(value: string): string {
    const text = platform === "win32" ? windowsSeparators(value) : value
    const root = parse(text).root
    let cursor = root
    try {
      cursor = realpath(root)
    } catch {
      // 无权读取祖先时保留词法前缀，已知根仍由其他候选比较。
    }
    let start = root.length
    for (let index = start; index <= text.length; index++) {
      if (index !== text.length && text[index] !== separator) continue
      const part = stringSlice(text, start, index)
      start = index + 1
      if (!part || part === ".") continue
      if (part === "..") cursor = dirname(cursor)
      else {
        cursor = join(cursor, part)
        try {
          cursor = realpath(cursor)
        } catch {
          // 目标尚不存在时沿用已解析的真实父目录。
        }
      }
    }
    return cursor
  }

  /** 检查路径或 fd 是否落在受保护目录，必要时同时检查祖先目录。 */
  check(value: unknown, operation: string, ancestors = false): void {
    if (typeof value === "number") {
      this.fd(value, operation)
      return
    }
    if (typeof value !== "string" && !isBytes(value)) return
    const text = typeof value === "string" ? value : decodeLoose(value)
    const absolute = absoluteName(text)
    const lexical = resolve(absolute)
    const candidates = [
      normalize(lexical),
      normalize(this.#canonical(typeof value === "string" ? absolute : value)),
    ]
    const physical = (value: string) => {
      if (
        regexpTest(
          platform === "win32" ? /(?:^|[\\/])\.\.(?:[\\/]|$)/ : /(?:^|\/)\.\.(?:\/|$)/,
          value,
        )
      )
        arrayPush(candidates, normalize(this.#physical(value)))
    }
    physical(absolute)
    if (platform === "win32") {
      const alias = windowsAlias(absolute)
      if (alias !== absolute) {
        arrayPush(candidates, normalize(resolve(alias)))
        arrayPush(candidates, normalize(this.#canonical(alias)))
        physical(alias)
      }
    }
    arrayEach(this.#roots, root => {
      arrayEach(candidates, candidate => {
        if (within(root, candidate) || (ancestors && within(candidate, root)))
          this.#deny(operation, lexical)
      })
    })
  }

  /** 登记 fd 与打开时的路径身份。 */
  track(fd: number, value: unknown): void {
    if (!numberIsInteger(fd) || (typeof value !== "string" && !isBytes(value))) return
    const text = typeof value === "string" ? value : decodeLoose(value)
    const name = absoluteName(text)
    try {
      const { dev, ino } = fstat(fd)
      mapSet(this.#fds, fd, {
        name: this.#canonical(typeof value === "string" ? name : value),
        dev,
        ino,
      })
    } catch {
      // 返回值无效时保留原调用结果，后续由 Node 检查 fd。
    }
  }

  /** 移除已关闭 fd 的登记。 */
  forget(fd: number): void {
    mapDelete(this.#fds, fd)
  }

  /** 检查 fd 指向的文件是否受保护。 */
  fd(fd: number, operation: string): void {
    // Linux 可核验安装前打开的常规文件；socket/pipe 不视为文件路径。
    if (platform === "linux" && numberIsInteger(fd)) {
      let name: string | undefined
      try {
        name = readlink(`/proc/self/fd/${fd}`)
      } catch {
        // 系统未提供 fd 路径时，回退到本实例登记。
      }
      if (name && isAbsolute(name)) {
        this.check(stringEndsWith(name, " (deleted)") ? stringSlice(name, 0, -10) : name, operation)
        return
      }
    }
    const record = mapGet(this.#fds, fd)
    if (!record) return
    // fd 可能被外部代码关闭后复用；与当前文件身份不同时不沿用旧映射。
    try {
      const current = fstat(fd)
      if (current.dev !== record.dev || current.ino !== record.ino) return
    } catch {
      return
    }
    this.check(record.name, operation)
  }
}
