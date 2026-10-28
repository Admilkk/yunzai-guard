import fs from "node:fs";
import path from "node:path";
export const coreProfiles = Object.freeze({
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
});
/** 依据根目录 package.json 名称及加载器文件识别核心，读取失败时按 TRSS 处理。 */
export function detectCoreProfile(root) {
    try {
        const file = path.join(root, "package.json");
        const info = fs.lstatSync(file);
        if (!info.isFile() || info.size > 256 * 1024)
            return coreProfiles.trss;
        const name = JSON.parse(fs.readFileSync(file, "utf8"))?.name;
        if (name === "jiuli" && fs.existsSync(path.join(root, coreProfiles.jiuli.loaderFile)))
            return coreProfiles.jiuli;
    }
    catch {
        // 无法识别时保持原有行为。
    }
    return coreProfiles.trss;
}
/** 可选观察允许降级，但明确选择的强制保护不能静默失效。 */
export function requiresCoreLoaderBridge(settings) {
    return (settings.isolationMode !== "managed" ||
        settings.pluginSandbox.plugins.some(plugin => plugin.enabled) ||
        settings.pluginSandbox.native.plugins.some(plugin => plugin.enabled) ||
        settings.rules.some(rule => rule.action !== "audit") ||
        (settings.protect.enabled && settings.protect.action !== "audit"));
}
/** 仅在内存中改写已识别的导出或调用点，不猜测陌生加载器的结构。 */
export function instrumentCoreLoaderSource(source, nativeEnabled, profile = coreProfiles.trss) {
    const bridge = `globalThis[Symbol.for("yunzai.guard.loader.bridge.v1")]`;
    const marker = "export default new PluginsLoader()";
    const replacements = profile.id === "jiuli"
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
        ];
    if (source.split(marker).length !== 2 ||
        !source.includes(profile.construction) ||
        (nativeEnabled &&
            (!profile.nativeSandbox ||
                replacements.some(([original]) => source.split(original).length !== 2))))
        return undefined;
    let result = source;
    if (nativeEnabled)
        for (const [original, replacement] of replacements)
            result = result.replace(original, replacement);
    return result
        .replaceAll(profile.construction, `${bridge}.construct(${profile.constructArgs})`)
        .replace(marker, `export default ${bridge}.loader(new PluginsLoader())`);
}
//# sourceMappingURL=loader.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("monitor/loader.ts", { coreProfiles, detectCoreProfile, requiresCoreLoaderBridge, instrumentCoreLoaderSource })
