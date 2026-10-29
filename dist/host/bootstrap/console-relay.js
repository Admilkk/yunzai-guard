/**
 * Windows 冷接管时原进程在提交交接前等待控制台转印进程就绪的上限。
 * 宿主等待交接提交的期限须计入这段时间，否则转印进程启动慢时会挤掉原进程的退出准备时间。
 * 原进程与宿主共用，单独成文件，避免把任一侧的模块并入另一侧组件。
 */
export const consoleRelayTimeout = 10000;
//# sourceMappingURL=console-relay.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../../protect/objects.js"
__guardRegisterExports("host/bootstrap/console-relay.ts", { consoleRelayTimeout })
