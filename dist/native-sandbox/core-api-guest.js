import PluginsLoader, { nativeCoreApi } from "./core-loader-guest.js";
// 仅导出插件 API 的进程内副本，不导出核心启动、Redis 初始化或全局注入入口。
export const { BasePlugin, cfg, util, Handler, Runtime, metrics, renderService, RendererLoader, TemplateRenderer, segment, getSegment, extendSegment, logger, chalk, setLog, } = nativeCoreApi();
export { PluginsLoader };
//# sourceMappingURL=core-api-guest.js.map