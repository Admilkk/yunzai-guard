import {
  apply,
  regexpTest,
  stringSlice,
  stringLower,
  stringStartsWith,
  stringIndexOf,
  stringEndsWith,
} from "./intrinsics.js"

const Bytes = Uint8Array
const decode = new TextDecoder("utf-16le", { fatal: true })
const decodeText = decode.decode.bind(decode)
const maxText = 128 * 1024
const exec = RegExp.prototype.exec
const point = String.fromCodePoint
const integer = Number.parseInt

export function shellEscape(
  text: string,
  at: number,
  powershell: boolean,
): { value: string; end: number } | undefined {
  const next = text[at + 1]
  if (next === undefined) return { value: text[at], end: at }
  if (next === "\n") return { value: "", end: at + 1 }
  if (next === "\r" && text[at + 2] === "\n") return { value: "", end: at + 2 }
  if (powershell) {
    if (next === "u" && text[at + 2] === "{") {
      const match = apply(exec, /^u\{([a-f\d]{1,6})\}/i, [
        stringSlice(text, at + 1),
      ]) as RegExpExecArray | null
      if (!match) return
      const code = integer(match[1], 16)
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return
      return { value: point(code), end: at + match[0].length }
    }
    const letters = "0abefnrtv",
      values = ["\0", "\x07", "\b", "\x1b", "\f", "\n", "\r", "\t", "\x0b"]
    for (let index = 0; index < letters.length; index++)
      if (next === letters[index]) return { value: values[index], end: at + 1 }
  }
  return { value: next, end: at + 1 }
}

export function isShellProgram(file: string): boolean {
  const lower = stringLower(file)
  return regexpTest(
    /(?:^|[\\/])(?:sh|bash|dash|ash|zsh|ksh|fish|cmd|powershell|pwsh)(?:\.exe)?$/,
    lower,
  )
}

export function powershellInlineOption(value: string): "encoded" | "plain" | undefined {
  const lower = stringLower(value)
  if (lower.length >= 2 && (stringStartsWith("-encodedcommand", lower) || lower === "-ec"))
    return "encoded"
  if (lower.length >= 2 && stringStartsWith("-command", lower)) return "plain"
}

/** PowerShell -EncodedCommand is UTF-16LE, not UTF-8. Never evaluate decoded text. */
export function decodeShellCommand(value: string): string | undefined {
  if (value.length > maxText || !regexpTest(/^[A-Za-z0-9+/]*={0,2}$/, value)) return
  if (!value || value.length % 4 !== 0) return
  try {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    const padding = stringEndsWith(value, "==") ? 2 : stringEndsWith(value, "=") ? 1 : 0
    const length = (value.length / 4) * 3 - padding
    if (length % 2) return
    const bytes = new Bytes(length)
    let offset = 0
    for (let index = 0; index < value.length; index += 4) {
      const a = stringIndexOf(alphabet, value[index]),
        b = stringIndexOf(alphabet, value[index + 1])
      const c = value[index + 2] === "=" ? 0 : stringIndexOf(alphabet, value[index + 2]),
        d = value[index + 3] === "=" ? 0 : stringIndexOf(alphabet, value[index + 3])
      if (a < 0 || b < 0 || c < 0 || d < 0) return
      if (
        index + 4 === value.length &&
        ((padding === 2 && (b & 15) !== 0) || (padding === 1 && (c & 3) !== 0))
      )
        return
      bytes[offset++] = (a << 2) | (b >> 4)
      if (offset < length) bytes[offset++] = (b << 4) | (c >> 2)
      if (offset < length) bytes[offset++] = (c << 6) | d
    }
    const text = decodeText(bytes)
    if (text.length > maxText || regexpTest(/\0/, text)) return
    return text
  } catch {}
}

/** Extract $(...) without evaluating it; quote and nesting boundaries are preserved. */
export function shellSubstitution(
  text: string,
  start: number,
): { text: string; end: number } | undefined {
  let depth = 1,
    quote = ""
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (char === "\\" && quote !== "'") {
      index++
      continue
    }
    if (quote) {
      if (char === quote) quote = ""
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "(") depth++
    if (char === ")") {
      depth--
      if (depth === 0) return { text: stringSlice(text, start, index), end: index }
    }
  }
}
