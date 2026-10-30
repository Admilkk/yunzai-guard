// 生成 dist/components.json：记录每个发布文件的摘要与所属组件，更新时据此判断能否热替换。
// 组件按静态导入图划分；以文件路径启动的入口（子进程、线程、预加载）单独作为对应组件的入口，
// 不沿这类引用合并依赖图，否则宿主引用业务预加载会把整个业务侧并入宿主。
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const output = path.join(root, "dist", "components.json")

// 发布包中的条目，与 scripts/package.mjs 保持一致。
const items = ["index.js", "dist", "native", "examples", "package.json"]
const metaFiles = new Set([
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "SECURITY.md",
  "settings.example.yaml",
  "settings.plugin-sandbox.example.yaml",
])

// 宿主外壳：Guard 宿主进程、启动器、CLI、控制台转印与 PM2 适配的入口。
const shellEntries = [
  "dist/host/supervisor.js",
  "dist/launcher.js",
  "dist/entry.js",
  "dist/cli.js",
  "dist/entry/console.js",
  "dist/entry/launcher.js",
  "dist/entry/preload.js",
  "dist/pm2-compat.js",
  "dist/pm2-compat-v2.js",
  "dist/pm2-daemon.js",
  "dist/pm2-preload.cjs",
  "dist/bootstrap-exit-watch.js",
  "dist/pm2/agent-v2.js",
  "dist/pm2/inspector-session-v1.js",
]
// 业务侧：运行在 Yunzai 进程及其沙箱子进程、线程中的入口。路径启动的其余入口会自动补入。
const workerEntries = [
  "index.js",
  "dist/entry/plugin.js",
  "dist/worker-preload.js",
  "dist/child-preload.js",
  "dist/runtime-bootstrap.cjs",
]
// 可热替换的宿主核心：控制台服务，在宿主进程内按代号重新加载。
const coreEntries = ["dist/web/index.js"]

const posix = file => file.split(path.sep).join("/")
const relative = file => posix(path.relative(root, file))

/** 列出发布条目中的全部文件。 */
function listFiles() {
  const result = []
  const walk = current => {
    const info = fs.lstatSync(current)
    if (info.isDirectory())
      for (const name of fs.readdirSync(current)) walk(path.join(current, name))
    else if (info.isFile()) result.push(relative(current))
  }
  for (const item of items) if (fs.existsSync(path.join(root, item))) walk(path.join(root, item))
  return result.filter(file => file !== "dist/components.json").sort()
}

/** 把相对引用解析成发布文件；目录或包外引用返回 undefined。 */
function resolveReference(from, specifier, files) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined
  const base = posix(path.normalize(path.join(path.dirname(from), specifier)))
  for (const candidate of [base, `${base}.js`, `${base}/index.js`])
    if (files.has(candidate)) return candidate
  return undefined
}

/** 读取一个脚本的静态导入，以及以路径启动的入口。 */
function references(file, files) {
  const text = fs.readFileSync(path.join(root, file), "utf8")
  const imports = ts
    .preProcessFile(text, true, true)
    .importedFiles.map(item => resolveReference(file, item.fileName, files))
    .filter(Boolean)
  const launched = []
  const patterns = [
    /new URL\(\s*["'`](\.{1,2}\/[^"'`]+)["'`]\s*,\s*import\.meta\.url\s*\)/g,
    /path\.(?:join|resolve)\(\s*__dirname\s*,\s*["'`](\.{1,2}\/[^"'`]+)["'`]\s*\)/g,
  ]
  for (const pattern of patterns)
    for (const match of text.matchAll(pattern)) {
      const target = resolveReference(file, match[1], files)
      if (target) launched.push(target)
    }
  return { imports, launched }
}

/** 从入口沿静态导入遍历，返回依赖图与途中发现的路径入口。 */
function walkGraph(entries, files, cache) {
  const seen = new Set()
  const launched = new Set()
  const stack = entries.filter(entry => files.has(entry))
  while (stack.length) {
    const file = stack.pop()
    if (seen.has(file)) continue
    seen.add(file)
    if (!/\.(?:c|m)?js$/.test(file)) continue
    const found = cache.get(file) ?? references(file, files)
    cache.set(file, found)
    stack.push(...found.imports)
    for (const item of found.launched) launched.add(item)
  }
  return { seen, launched }
}

const fileList = listFiles()
const files = new Set(fileList)
for (const entry of [...shellEntries, ...workerEntries, ...coreEntries])
  if (!files.has(entry) && !entry.startsWith("dist/pm2/")) throw new Error(`缺少组件入口：${entry}`)

const cache = new Map()
const shell = walkGraph(shellEntries, files, cache)
const core = walkGraph(coreEntries, files, cache)
// 路径启动的入口若不属于宿主外壳，就是业务侧（预加载、沙箱子进程与线程）；反复展开直到不再新增。
const workerRoots = new Set(workerEntries)
let worker
for (;;) {
  worker = walkGraph([...workerRoots], files, cache)
  const before = workerRoots.size
  for (const graph of [shell, worker, core])
    for (const item of graph.launched)
      if (!shellEntries.includes(item) && !item.startsWith("dist/panel/")) workerRoots.add(item)
  if (workerRoots.size === before) break
}

/** 只含类型声明的源文件编译后是空模块，运行时没有内容，改动不影响任何组件。 */
function typeOnly(file) {
  if (!/\.c?js$/.test(file)) return false
  const text = fs
    .readFileSync(path.join(root, file), "utf8")
    .replace(/\/\/# sourceMappingURL=.*$/m, "")
    .trim()
  return (
    text === "export {};" ||
    /^"use strict";\s*Object\.defineProperty\(exports, "__esModule", \{ value: true \}\);$/.test(
      text,
    )
  )
}

/** 按依赖图与目录归属给文件分配组件。 */
function rolesOf(file) {
  if (metaFiles.has(file) || file.startsWith("examples/")) return ["meta"]
  if (/\.d\.c?ts$|\.map$/.test(file)) return ["meta"]
  if (file.startsWith("dist/panel/")) return ["static"]
  if (typeOnly(file)) return ["meta"]
  const roles = []
  if (shell.seen.has(file)) roles.push("shell")
  if (worker.seen.has(file)) roles.push("worker")
  if (core.seen.has(file)) roles.push("core")
  // 未被任何图引用的运行文件（原生程序、数据文件等）按宿主外壳保守处理。
  return roles.length ? roles : ["shell"]
}

const hash = file =>
  createHash("sha256")
    .update(fs.readFileSync(path.join(root, file)))
    .digest("hex")
const manifest = {
  schema: 1,
  version: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version,
  files: Object.fromEntries(
    fileList.map(file => [file, { sha256: hash(file), roles: rolesOf(file) }]),
  ),
}
fs.writeFileSync(output, `${JSON.stringify(manifest)}\n`)

const count = role => fileList.filter(file => manifest.files[file].roles.includes(role)).length
console.log(
  `组件清单：${fileList.length} 个文件（宿主 ${count("shell")}，业务 ${count("worker")}，核心 ${count("core")}，静态 ${count("static")}）`,
)
