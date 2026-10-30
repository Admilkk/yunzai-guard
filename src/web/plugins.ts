import fs from "node:fs"
import path from "node:path"
import { reservedDirectories } from "../native-sandbox/config.js"

export interface PluginEntry {
  /** 目录名，同时是原生沙盒的 id。 */
  id: string
  /** 核心目录或 Guard 自身，不能作为原生沙盒对象。 */
  reserved: boolean
  description?: string
}

/** 读取插件目录的 package.json 描述。 */
function describe(directory: string): string | undefined {
  try {
    const file = path.join(directory, "package.json")
    const info = fs.statSync(file)
    if (!info.isFile() || info.size > 64 * 1024) return undefined
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { description?: unknown }
    return typeof parsed.description === "string" ? parsed.description.slice(0, 160) : undefined
  } catch {
    return undefined
  }
}

/** 只读取目录项，不加载插件代码。 */
export function listPlugins(root: string): PluginEntry[] {
  const directory = path.join(root, "plugins")
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const result: PluginEntry[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue
    if (entry.name === "node_modules") continue
    const id = entry.name
    const description = describe(path.join(directory, id))
    result.push({
      id,
      reserved: reservedDirectories.has(id.toLowerCase()),
      ...(description ? { description } : {}),
    })
  }
  return result.sort((a, b) => {
    if (a.reserved !== b.reserved) return a.reserved ? 1 : -1
    return a.id.localeCompare(b.id, "zh")
  })
}
