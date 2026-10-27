import fs from "node:fs"
import { fileURLToPath } from "node:url"

let label: string | undefined

/** 状态展示用的引擎标识，版本取自构建时写入的 vendor 清单。 */
export function sandboxEngineLabel(): string {
  if (label) return label
  label = "vm2"
  try {
    const manifest: unknown = JSON.parse(
      fs.readFileSync(fileURLToPath(new URL("../vendor/manifest.json", import.meta.url)), "utf8"),
    )
    const entry = Array.isArray(manifest)
      ? manifest.find(item => item && typeof item === "object" && item.name === "vm2")
      : undefined
    if (typeof entry?.version === "string" && /^\d+\.\d+\.\d+$/.test(entry.version))
      label = `vm2-${entry.version}`
  } catch {
    // 清单缺失只影响状态展示。
  }
  return label
}
