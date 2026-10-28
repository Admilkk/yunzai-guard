// 生成发布资产：Linux 包、macOS 包（与 Linux 包同源，纯 JS 运行）、随附固定 Node 的 Windows 包、独立 node.exe 与校验和。
// 需先执行 npm run build；Windows 运行时按 src/dependencies/node.ts 中的固定地址与摘要下载核验。
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { create as createTar } from "tar"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const out = path.join(root, "release")
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
const { windowsNode, bundledNode, downloadNode } = await import(
  new URL("../dist/dependencies/node.js", import.meta.url)
)
const files = [
  "index.js",
  "dist",
  "native",
  "examples",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "SECURITY.md",
  "settings.example.json",
  "settings.plugin-sandbox.example.json",
]
const name = `yunzai-guard-v${pkg.version}`
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", windowsHide: true })
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} 失败`)
}

/** 复制发布文件；package.json 去掉开发依赖与 prepare，避免工作区安装时重新构建。 */
function stage(directory) {
  fs.mkdirSync(directory, { recursive: true })
  for (const item of files) {
    const source = path.join(root, item)
    if (!fs.existsSync(source)) throw new Error(`缺少发布文件：${item}`)
    fs.cpSync(source, path.join(directory, item), { recursive: true, verbatimSymlinks: true })
  }
  const { devDependencies, scripts, ...release } = pkg
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(release, null, 2) + "\n")
  for (const file of ["README.md", "SECURITY.md"]) {
    const target = path.join(directory, file)
    const content = fs.readFileSync(target, "utf8")
    fs.writeFileSync(
      target,
      content.replace(
        /\]\((docs\/[^)]+)\)/g,
        "](https://github.com/Admilkk/yunzai-guard/blob/main/$1)",
      ),
    )
  }
}

function archive(directory, file) {
  const parent = path.dirname(directory)
  const base = path.basename(directory)
  if (file.endsWith(".zip"))
    process.platform === "win32"
      ? run(
          path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe"),
          ["-a", "-cf", file, base],
          parent,
        )
      : run("zip", ["-qr", file, base], parent)
  else
    createTar(
      {
        cwd: parent,
        file,
        gzip: true,
        portable: true,
        sync: true,
        /** Windows 文件模式不能反映 Linux 辅助程序的执行权限。 */
        onWriteEntry(entry) {
          if (
            entry.path === `${base}/native/bubblewrap/bin/linux-x64/bwrap` ||
            entry.path === `${base}/native/process-identity/bin/linux-x64/process-identity`
          )
            entry.stat.mode = 0o755
        },
      },
      [base],
    )
}

if (!fs.existsSync(path.join(root, "dist", "launcher.js")))
  throw new Error("请先执行 npm run build")
fs.rmSync(out, { recursive: true, force: true })
const staging = path.join(out, "staging")

const linux = path.join(staging, "linux", "yunzai-guard")
stage(linux)
archive(linux, path.join(out, `${name}-linux-x64.tar.gz`))
archive(linux, path.join(out, `${name}-macos.tar.gz`))

const windows = path.join(staging, "windows", "yunzai-guard")
stage(windows)
const node = bundledNode(windows)
fs.mkdirSync(path.dirname(node), { recursive: true })
await downloadNode(node)
archive(windows, path.join(out, `${name}-win-x64.zip`))
const exe = path.join(out, `node-v${windowsNode.version}-win-x64.exe`)
fs.copyFileSync(node, exe)
fs.chmodSync(exe, 0o644)

fs.rmSync(staging, { recursive: true, force: true })
const sums = fs
  .readdirSync(out)
  .sort()
  .map(item => `${hash(path.join(out, item))}  ${item}`)
fs.writeFileSync(path.join(out, "SHA256SUMS.txt"), sums.join("\n") + "\n")
process.stdout.write(sums.join("\n") + "\n")
