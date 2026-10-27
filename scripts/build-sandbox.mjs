import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const vendor = path.join(root, "dist", "vendor")
const packages = ["vm2", "acorn", "acorn-walk"]
const manifest = []

function atLeast(version, minimum) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version))
  if (!match) return false
  for (let index = 0; index < 3; index++) {
    const part = Number(match[index + 1])
    if (part !== minimum[index]) return part > minimum[index]
  }
  return true
}
const notices = []
if (fs.lstatSync(path.join(root, "dist")).isSymbolicLink())
  throw new Error("Refusing linked dist directory")
fs.mkdirSync(vendor, { recursive: true })
if (fs.lstatSync(vendor).isSymbolicLink()) throw new Error("Refusing linked vendor directory")
const dependencies = path.join(vendor, "node_modules")
fs.mkdirSync(dependencies, { recursive: true })
if (fs.lstatSync(dependencies).isSymbolicLink())
  throw new Error("Refusing linked vendor dependencies directory")
const vmPackage = require.resolve("vm2/package.json")
const vmRequire = createRequire(vmPackage)
for (const name of packages) {
  const source = path.dirname(vmRequire.resolve(`${name}/package.json`))
  const metadata = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"))
  // 允许 3.12.2 及以上的正式版；运行时自检仍会拒绝接口不兼容的版本。
  if (name === "vm2" && !atLeast(metadata.version, [3, 12, 2]))
    throw new Error(`vm2 ${metadata.version} 低于 3.12.2，请先评审沙箱适配`)
  const destination =
    name === "vm2" ? path.join(vendor, name) : path.join(vendor, "node_modules", name)
  // 构建仅替换 dist/vendor 内这些包自身的目录。
  if (!path.resolve(destination).startsWith(`${path.resolve(vendor)}${path.sep}`))
    throw new Error("Invalid vendor destination")
  const resolvedParent = fs.realpathSync(path.dirname(destination))
  const resolvedVendor = fs.realpathSync(vendor)
  if (
    resolvedParent !== resolvedVendor &&
    !resolvedParent.startsWith(`${resolvedVendor}${path.sep}`)
  )
    throw new Error("Vendor destination resolves outside its build directory")
  try {
    if (fs.lstatSync(destination).isSymbolicLink())
      throw new Error("Refusing linked vendor package")
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  fs.rmSync(destination, { recursive: true, force: true })
  fs.cpSync(source, destination, { recursive: true, dereference: true })
  const license = fs.readdirSync(source).find(file => /^license(?:\.md|\.txt)?$/i.test(file))
  if (!license) throw new Error(`Missing license for ${name}`)
  notices.push(
    `${name} ${metadata.version}\n${fs.readFileSync(path.join(source, license), "utf8")}`,
  )
  manifest.push({ name, version: metadata.version, license: metadata.license })
}
fs.writeFileSync(
  path.join(root, "dist", "SANDBOX-THIRD-PARTY-LICENSES.txt"),
  `${notices.join("\n\n")}\n`,
)
fs.writeFileSync(path.join(vendor, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
