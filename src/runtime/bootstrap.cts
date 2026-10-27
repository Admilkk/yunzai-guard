// 在调用方的 --require 模块前同步安装；导入链不能包含顶层 await。
const runtime = require("./index.js") as typeof import("./index.js")
runtime.installInheritedRuntime()
