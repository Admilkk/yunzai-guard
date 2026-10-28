// 兼容既有调用方的稳定入口；新守护进程代码直接导入带版本的实现，
// 避免依赖旧守护进程已缓存的此 URL。
export * from "./compat-v2.js";
//# sourceMappingURL=compat.js.map