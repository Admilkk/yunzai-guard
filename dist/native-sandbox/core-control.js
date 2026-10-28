export class NativeCoreControlDenied extends Error {
    code = "NATIVE_CORE_DENIED";
}
/** 权限来自当前宿主请求，不能信任插件提供的 isMaster 字段。 */
export function requireNativeRestartCapability(args, requestType, event, alreadyRequested, permitted) {
    if (!permitted ||
        args.length ||
        requestType !== "native-call" ||
        event?.isMaster !== true ||
        alreadyRequested)
        throw new NativeCoreControlDenied("Core restart requires an explicit plugin grant and one live host-authenticated master request");
}
//# sourceMappingURL=core-control.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("native-sandbox/core-control.ts", { NativeCoreControlDenied, requireNativeRestartCapability })
