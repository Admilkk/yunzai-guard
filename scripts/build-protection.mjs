import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const root = fileURLToPath(new URL("../", import.meta.url))
const source = path.join(root, "src")
const output = path.join(root, "dist")
const marker = "\n// Guard 自有导出登记。\n"
let count = 0

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) visit(filename)
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      const relative = path.relative(source, filename).replaceAll("\\", "/")
      // 捕获入口由 objects 直接登记，避免启动时形成导入循环；
      // 业务核心转发保留原型，文案模块只导出冻结数据。
      if (
        relative === "protect/objects.ts" ||
        relative === "protect/intrinsics.ts" ||
        relative === "shared/messages.ts" ||
        relative === "native-sandbox/core-api-guest.ts"
      )
        continue
      const destination = path.join(output, relative.replace(/\.ts$/, ".js"))
      const original = fs.readFileSync(destination, "utf8").split(marker)[0]
      const parsed = ts.createSourceFile(destination, original, ts.ScriptTarget.Latest, true)
      const names = new Set()
      for (const statement of parsed.statements) {
        if (
          ts.isExportDeclaration(statement) &&
          !statement.moduleSpecifier &&
          statement.exportClause &&
          ts.isNamedExports(statement.exportClause)
        ) {
          for (const item of statement.exportClause.elements)
            names.add((item.propertyName ?? item.name).text)
          continue
        }
        if (!statement.modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword)) continue
        if (
          (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) &&
          statement.name
        )
          names.add(statement.name.text)
        if (ts.isVariableStatement(statement))
          for (const declaration of statement.declarationList.declarations)
            if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text)
      }
      if (!names.size) continue
      let dependency = path
        .relative(path.dirname(destination), path.join(output, "protect/objects.js"))
        .replaceAll("\\", "/")
      if (!dependency.startsWith(".")) dependency = "./" + dependency
      fs.writeFileSync(
        destination,
        original +
          marker +
          `import { registerModule as __guardRegisterExports } from ${JSON.stringify(dependency)}\n` +
          `__guardRegisterExports(${JSON.stringify(relative)}, { ${[...names].join(", ")} })\n`,
      )
      count++
    }
  }
}
visit(source)
console.log(`已登记 ${count} 个自有模块的导出函数`)
