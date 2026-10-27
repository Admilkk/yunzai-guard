import fs from "node:fs"
import path from "node:path"
import type { GuardSettings } from "../shared/types.js"

/** 已适配的核心及其加载器桥接点；未识别的核心按 TRSS 处理，标记不符时降级。 */
export interface CoreProfile {
  id: "trss" | "jiuli"
  /** 实际实现 PluginsLoader 的文件，相对 Yunzai 根目录。 */
  loaderFile: string
  /** 每条消息创建插件实例的原始表达式。 */
  construction: string
  /** 改写为桥接构造时的参数：构造器、参数数组、插件名。 */
  constructArgs: string
  /** 是否已适配独立插件沙箱所需的规则与上下文桥接。 */
  nativeSandbox: boolean
}

export const coreProfiles: Readonly<Record<CoreProfile["id"], Readonly<CoreProfile>>> =
  Object.freeze({
    trss: Object.freeze({
      id: "trss",
      loaderFile: "lib/plugins/loader.js",
      construction: "new i.class(e)",
      constructArgs: "i.class, [e], i.key",
      nativeSandbox: true,
    }),
    // JiuLi 的 lib/plugins/loader.js 只是转发，实现位于编译后的 lib/core/loader.js。
    jiuli: Object.freeze({
      id: "jiuli",
      loaderFile: "lib/core/loader.js",
      construction: "new entry.class(e)",
      constructArgs: "entry.class, [e], entry.key",
      nativeSandbox: true,
    }),
  })

/** 依据根目录 package.json 名称及加载器文件识别核心，读取失败时按 TRSS 处理。 */
export function detectCoreProfile(root: string): Readonly<CoreProfile> {
  try {
    const file = path.join(root, "package.json")
    const info = fs.lstatSync(file)
    if (!info.isFile() || info.size > 256 * 1024) return coreProfiles.trss
    const name = (JSON.parse(fs.readFileSync(file, "utf8")) as { name?: unknown } | null)?.name
    if (name === "jiuli" && fs.existsSync(path.join(root, coreProfiles.jiuli.loaderFile)))
      return coreProfiles.jiuli
  } catch {
    // 无法识别时保持原有行为。
  }
  return coreProfiles.trss
}

/** 可选观察允许降级，但明确选择的强制保护不能静默失效。 */
export function requiresCoreLoaderBridge(settings: GuardSettings): boolean {
  return (
    settings.isolationMode !== "managed" ||
    settings.pluginSandbox.plugins.some(plugin => plugin.enabled) ||
    settings.pluginSandbox.native.plugins.some(plugin => plugin.enabled) ||
    settings.rules.some(rule => rule.action !== "audit") ||
    (settings.protect.enabled && settings.protect.action !== "audit")
  )
}

/** 仅在内存中改写已识别的导出或调用点，不猜测陌生加载器的结构。 */
export function instrumentCoreLoaderSource(
  source: string,
  nativeEnabled: boolean,
  profile: Readonly<CoreProfile> = coreProfiles.trss,
): string | undefined {
  const bridge = `globalThis[Symbol.for("yunzai.guard.loader.bridge.v1")]`
  const marker = "export default new PluginsLoader()"
  const replacements: Array<[string, string]> =
    profile.id === "jiuli"
      ? [
          ["probe.getContext()", "(await probe.getContext())"],
          ["probe.getContext(false, true)", "(await probe.getContext(false, true))"],
          ["v.reg.test(String(e.msg))", `await ${bridge}.testRule(v.reg, String(e.msg))`],
          ["v.reg.test('')", `await ${bridge}.testRule(v.reg, '')`],
          [
            "fn?.length >= 2 ? [e, v.reg.exec(String(e.msg)) || undefined] : [e]",
            `await ${bridge}.ruleArgs(fn, v.reg, e)`,
          ],
          [
            "Object.assign(Object.create(entry.class.prototype), entry.plugin)",
            "Object.assign(Object.create(entry.class.prototype), entry.plugin, { e })",
          ],
        ]
      : [
          ["i.plugin.getContext()", "(await i.plugin.getContext())"],
          ["i.plugin.getContext(false, true)", "(await i.plugin.getContext(false, true))"],
          ["v.reg.test(e.msg)", `await ${bridge}.testRule(v.reg, e.msg)`],
        ]
  if (
    source.split(marker).length !== 2 ||
    !source.includes(profile.construction) ||
    (nativeEnabled &&
      (!profile.nativeSandbox ||
        replacements.some(([original]) => source.split(original).length !== 2)))
  )
    return undefined
  let result = source
  if (nativeEnabled)
    for (const [original, replacement] of replacements)
      result = result.replace(original, replacement)
  return result
    .replaceAll(profile.construction, `${bridge}.construct(${profile.constructArgs})`)
    .replace(marker, `export default ${bridge}.loader(new PluginsLoader())`)
}
