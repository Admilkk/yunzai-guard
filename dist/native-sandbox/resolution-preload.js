import { installSandboxResolution } from "../sandbox/resolution.js";
// 原生插件的普通 Node 子进程保留自身 IPC 和启动生命周期。
// 此预加载仅提供可信规范模块映射，不执行握手。
installSandboxResolution(process.env.YUNZAI_GUARD_RESOLUTION_MANIFEST);
//# sourceMappingURL=resolution-preload.js.map