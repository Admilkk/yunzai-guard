import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const directory = fileURLToPath(new URL("../tests/", import.meta.url))
const group = process.argv[2] ?? "unit"
if (!["unit", "platform", "all"].includes(group)) throw new Error("Unknown test group: " + group)
const all = fs
  .readdirSync(directory)
  .filter(name => name.endsWith(".test.mjs"))
  .sort()
const platformFiles = JSON.parse(
  fs.readFileSync(path.join(directory, "platform-files.json"), "utf8"),
)
if (!Array.isArray(platformFiles) || platformFiles.some(name => !all.includes(name)))
  throw new Error("Platform test list contains an unknown file")
const platform = new Set(platformFiles)
if (platform.size !== platformFiles.length)
  throw new Error("Platform test list contains duplicates")
const selected = all.filter(
  name => group === "all" || platform.has(name) === (group === "platform"),
)
if (!selected.length) throw new Error("Test group is empty: " + group)

// 只选择文件并转交 Node 原生运行器，保留默认的逐文件进程隔离。
const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--test-concurrency=" + (group === "platform" ? 1 : 3),
    ...process.argv.slice(3),
    ...selected.map(name => path.join(directory, name)),
  ],
  { stdio: "inherit", windowsHide: true },
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
