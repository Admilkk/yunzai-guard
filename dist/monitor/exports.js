import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { parse } = require("../vendor/node_modules/acorn");
const { simple } = require("../vendor/node_modules/acorn-walk");
/**
 * 识别自身模块已初始化完成的直接函数或类导出。
 * 导入别名、工厂返回值及重新赋值的绑定仍保守延后处理。
 * 此语法分类仅作观察元数据，不能证明对恶意代码的防护。
 */
export function ownFunctionExports(source) {
    const program = parse(source, {
        ecmaVersion: "latest",
        sourceType: "module",
        allowHashBang: true,
    });
    const locals = new Map();
    const written = new Set();
    let directEval = false;
    /** 登记函数或类声明的名称。 */
    function declaration(node) {
        if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id)
            locals.set(node.id.name, false);
        if (node.type === "VariableDeclaration")
            for (const item of node.declarations)
                if (item.id.type === "Identifier" &&
                    item.init &&
                    ["FunctionExpression", "ArrowFunctionExpression", "ClassExpression"].includes(item.init.type))
                    locals.set(item.id.name, node.kind === "const");
    }
    /** 从导出语句中收集导出的函数与类名。 */
    function write(node) {
        if (!node)
            return;
        if (node.type === "Identifier")
            written.add(node.name);
        else if (node.type === "ArrayPattern")
            for (const item of node.elements)
                write(item);
        else if (node.type === "ObjectPattern")
            for (const item of node.properties)
                write(item.type === "RestElement" ? item.argument : item.value);
        else if (node.type === "AssignmentPattern")
            write(node.left);
        else if (node.type === "RestElement")
            write(node.argument);
    }
    for (const statement of program.body) {
        if (statement.type === "ExportNamedDeclaration" && statement.declaration)
            declaration(statement.declaration);
        else if (statement.type === "ExportDefaultDeclaration")
            declaration(statement.declaration);
        else
            declaration(statement);
    }
    simple(program, {
        AssignmentExpression: node => write(node.left),
        UpdateExpression: node => write(node.argument),
        ForInStatement: node => write(node.left),
        ForOfStatement: node => write(node.left),
        CallExpression: node => {
            if (node.callee.type === "Identifier" && node.callee.name === "eval")
                directEval = true;
        },
    });
    const own = (local) => locals.has(local) && !written.has(local) && (!directEval || locals.get(local) === true);
    const result = new Set();
    for (const statement of program.body) {
        if (statement.type === "ExportDefaultDeclaration") {
            const value = statement.declaration;
            if (["FunctionExpression", "ArrowFunctionExpression", "ClassExpression"].includes(value.type) ||
                ((value.type === "FunctionDeclaration" || value.type === "ClassDeclaration") &&
                    (!value.id || own(value.id.name))) ||
                (value.type === "Identifier" && own(value.name)))
                result.add("default");
        }
        else if (statement.type === "ExportNamedDeclaration") {
            if (statement.declaration) {
                const value = statement.declaration;
                if ((value.type === "FunctionDeclaration" || value.type === "ClassDeclaration") &&
                    own(value.id.name))
                    result.add(value.id.name);
                if (value.type === "VariableDeclaration")
                    for (const item of value.declarations)
                        if (item.id.type === "Identifier" && own(item.id.name))
                            result.add(item.id.name);
            }
            if (!statement.source)
                for (const specifier of statement.specifiers)
                    if (specifier.local.type === "Identifier" && own(specifier.local.name)) {
                        const exported = specifier.exported;
                        if (exported.type === "Identifier")
                            result.add(exported.name);
                        else if (typeof exported.value === "string")
                            result.add(exported.value);
                    }
        }
    }
    return result;
}
//# sourceMappingURL=exports.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("monitor/exports.ts", { ownFunctionExports })
