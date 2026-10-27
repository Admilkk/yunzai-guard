import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const runs = fs.realpathSync.native(path.join(repository, "tests/runs"))
const output = path.resolve(process.argv[2] || "")
if (path.dirname(output) !== runs || fs.existsSync(output))
  throw new Error("Freeze output must be one new directory directly beneath tests/runs")
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
const files = ["index.js"]
function collect(directory) {
  for (const entry of fs.readdirSync(path.join(repository, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`
    if (entry.isDirectory()) collect(relative)
    else if (entry.isFile()) files.push(relative)
    else throw new Error(`Runtime source cannot contain links: ${relative}`)
  }
}
collect("dist")
collect("native")
files.sort()
const manifest = {}
fs.mkdirSync(output)
for (const name of files) {
  const source = path.join(repository, name)
  const bytes = fs.readFileSync(source)
  manifest[name] = hash(bytes)
  const destination = path.join(output, "guard", name)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, bytes, { flag: "wx" })
  if (hash(fs.readFileSync(destination)) !== manifest[name])
    throw new Error(`Copy mismatch: ${name}`)
}
for (const name of files)
  if (hash(fs.readFileSync(path.join(repository, name))) !== manifest[name])
    throw new Error(`Source changed during freeze: ${name}`)
const bytes = JSON.stringify(manifest, null, 2) + "\n"
fs.writeFileSync(path.join(output, "guard-build.json"), bytes, { flag: "wx" })
console.log(
  JSON.stringify({
    root: path.join(output, "guard"),
    files: files.length,
    manifestSha256: hash(bytes),
  }),
)
