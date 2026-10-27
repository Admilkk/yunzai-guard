// 检查 src 的分层依赖：只允许依赖同层或更低层，类型导入不计。
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const source = fileURLToPath(new URL("../src/", import.meta.url))

// 自上而下首个匹配生效；按文件职责而非目录归层，避免为分层移动 PM2 已缓存的模块路径。
const layers = [
  { name: "基础层", match: ["shared/"] },
  {
    name: "原语层",
    match: [
      "protect/",
      "config/",
      "audit/",
      "host/policy.ts",
      "host/bootstrap/",
      "runtime/policy.ts",
      "plugin-sandbox/config.ts",
      "plugin-sandbox/policy.ts",
      "plugin-sandbox/types.ts",
      "native-sandbox/config.ts",
      "native-sandbox/types.ts",
    ],
  },
  {
    name: "能力层",
    match: [
      "monitor/",
      "instrumentation/",
      "native-process/",
      "sandbox/",
      "plugin-sandbox/",
      "native-sandbox/",
      "runtime/",
      "pm2/",
      "dependencies/files.ts",
      "dependencies/linux-bwrap.ts",
      "dependencies/node.ts",
      "dependencies/windows-broker.ts",
    ],
  },
  { name: "编排层", match: ["host/", "web/", "dependencies/"] },
  { name: "入口层", match: ["entry/", "cli/"] },
]

function layerOf(relative) {
  const index = layers.findIndex(layer =>
    layer.match.some(item => (item.endsWith("/") ? relative.startsWith(item) : relative === item)),
  )
  if (index < 0) throw new Error(`未归层的源码：${relative}`)
  return index
}

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) return files(file)
    return /\.c?ts$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [file] : []
  })
}

const resolveSource = (from, specifier) =>
  path
    .relative(source, path.resolve(path.dirname(from), specifier))
    .replaceAll("\\", "/")
    .replace(/\.c?js$/, extension => (extension === ".cjs" ? ".cts" : ".ts"))

const violations = []
for (const file of files(source)) {
  const relative = path.relative(source, file).replaceAll("\\", "/")
  const own = layerOf(relative)
  const parsed = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  )
  const check = (specifier, node) => {
    if (!specifier.startsWith(".")) return
    const target = resolveSource(file, specifier)
    // vendor 与 dist 根入口只在构建产物中存在，不属于源码分层。
    if (!fs.existsSync(path.join(source, target))) return
    const other = layerOf(target)
    if (other > own) {
      const { line } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed))
      violations.push(
        `${relative}:${line + 1}（${layers[own].name}）依赖了 ${target}（${layers[other].name}）`,
      )
    }
  }
  const visit = node => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !node.importClause?.isTypeOnly &&
      !node.isTypeOnly
    )
      check(node.moduleSpecifier.text, node)
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      check(node.arguments[0].text, node)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
}

if (violations.length) {
  console.error(`分层检查失败（${violations.length} 处）：\n` + violations.join("\n"))
  process.exit(1)
}
console.log("分层检查通过")
