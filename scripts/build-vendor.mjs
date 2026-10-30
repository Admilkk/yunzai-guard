// 把运行时用到的第三方库复制进 dist/vendor，并把编译产物中的包名引用改为相对路径。
// 发布包因此不依赖任何外部安装，也不会误用 Yunzai 根目录下的同名包。
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dist = path.join(root, "dist")

/** yaml 的浏览器构建是纯 ESM，不依赖 Node 内置模块。 */
const vendors = [
  {
    name: "yaml",
    source: path.join(root, "node_modules", "yaml"),
    // browser/package.json 声明 ESM；yaml 根目录的 package.json 是 CommonJS，不能单独带上。
    files: ["browser/dist", "browser/package.json", "LICENSE"],
    entry: "browser/dist/index.js",
    importers: ["config/yaml.js"],
  },
]

for (const vendor of vendors) {
  const target = path.join(dist, "vendor", vendor.name)
  fs.rmSync(target, { recursive: true, force: true })
  for (const item of vendor.files)
    fs.cpSync(path.join(vendor.source, item), path.join(target, item), { recursive: true })
  for (const importer of vendor.importers) {
    const file = path.join(dist, importer)
    const text = fs.readFileSync(file, "utf8")
    let relative = path
      .relative(path.dirname(file), path.join(target, vendor.entry))
      .split(path.sep)
      .join("/")
    if (!relative.startsWith(".")) relative = `./${relative}`
    // 重复执行时已改写过，直接跳过。
    if (text.includes(`from "${relative}"`)) continue
    const specifier = `from "${vendor.name}"`
    if (text.split(specifier).length !== 2)
      throw new Error(`${importer} 应恰好引用一次 ${vendor.name}`)
    fs.writeFileSync(file, text.replace(specifier, `from "${relative}"`))
  }
}
console.log(`vendored ${vendors.map(item => item.name).join(", ")}`)
