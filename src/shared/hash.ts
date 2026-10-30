import fs from "node:fs"
import { createHash } from "node:crypto"

/** 计算数据的 SHA-256 摘要，返回小写十六进制。 */
export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

/**
 * 分块计算文件的 SHA-256 摘要，读取缓冲区固定为 64 KiB。
 * @param file 要校验的文件路径；路径与文件类型由调用方校验。
 * @returns 小写十六进制摘要。
 */
export function hashFile(file: string): string {
  const handle = fs.openSync(file, "r")
  try {
    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let read: number
    while ((read = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, read))
    return hash.digest("hex")
  } finally {
    fs.closeSync(handle)
  }
}
