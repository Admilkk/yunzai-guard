import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"

const probeRoot = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(
  process.argv[2] ?? process.env.YUNZAI_SOURCE ?? path.join(probeRoot, "../../TRSS-Yunzai"),
)
const source = path.join(probeRoot, "source")
const dependencies = path.join(probeRoot, "bundle", "node_modules")
fs.mkdirSync(source, { recursive: true })
fs.mkdirSync(dependencies, { recursive: true })
const files = execFileSync(
  "git",
  ["ls-files", "-z", "--", "app.js", "lib", "config/default_config", "package.json"],
  { cwd: repo, encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
const hashes = {}
for (const file of files) {
  const original = path.join(repo, file)
  const destination = path.join(source, file)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(original, destination)
  hashes[file] = createHash("sha256").update(fs.readFileSync(original)).digest("hex")
}
fs.writeFileSync(path.join(probeRoot, "core-manifest.json"), JSON.stringify(hashes, null, 2))

function resolvePackage(name, from) {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, "node_modules", name)
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate)
    if (path.dirname(directory) === directory)
      throw new Error(`Cannot resolve ${name} from ${from}`)
  }
}

const installed = new Map()
function bundle(name, from, parentDestination = dependencies) {
  const original = resolvePackage(name, from)
  const rootDestination = path.join(dependencies, name)
  if (installed.get(rootDestination) === original) return
  const destination = installed.has(rootDestination)
    ? path.join(parentDestination, "node_modules", name)
    : rootDestination
  if (installed.get(destination) === original) return
  if (installed.has(destination)) throw new Error(`Dependency conflict: ${destination}`)
  installed.set(destination, original)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.cpSync(original, destination, {
    recursive: true,
    filter: file => path.relative(original, file).split(path.sep)[0] !== "node_modules",
  })
  const pkg = JSON.parse(fs.readFileSync(path.join(original, "package.json"), "utf8"))
  for (const dependency of Object.keys(pkg.dependencies ?? {}))
    bundle(dependency, original, destination)
}

for (const name of [
  "art-template",
  "chalk",
  "chokidar",
  "compression",
  "es-toolkit",
  "express",
  "file-type",
  "log4js",
  "lodash",
  "md5",
  "moment",
  "node-fetch",
  "node-schedule",
  "oicq",
  "redis",
  "ulid",
  "ws",
  "yaml",
])
  bundle(name, repo)
console.log(JSON.stringify({ source, coreFiles: files.length, dependencyPackages: installed.size }))
