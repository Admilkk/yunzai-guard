"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// 在调用方的 --require 模块前同步安装；导入链不能包含顶层 await。
const runtime = require("./index.js");
runtime.installInheritedRuntime();
//# sourceMappingURL=bootstrap.cjs.map