import { analyzeCommand } from "./command-analysis.js";
import { Paths } from "./paths.js";
import { arrayEach } from "./intrinsics.js";
/** 仅拒绝能够明确识别的 Guard 写入目标，解析不足与进程类型不构成拒绝理由。 */
export function createCommandGuard(options) {
    const writes = new Paths(options.roots, options.deny);
    return (operation, args) => {
        const analysis = analyzeCommand(operation, args);
        arrayEach(analysis.targets, target => {
            if (target.access === "write")
                writes.check(target.raw ?? target.path, operation, target.ancestors);
        });
    };
}
//# sourceMappingURL=commands.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "./objects.js"
__guardRegisterExports("protect/commands.ts", { createCommandGuard })
