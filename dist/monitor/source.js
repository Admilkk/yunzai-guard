import { types } from "node:util";
/** 按字节读取 Node 加载钩子源码，保留视图的准确偏移及长度。 */
export function decodeModuleSource(source) {
    if (typeof source === "string")
        return source;
    if (ArrayBuffer.isView(source))
        return Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString("utf8");
    if (types.isAnyArrayBuffer(source))
        return Buffer.from(source).toString("utf8");
    return undefined;
}
//# sourceMappingURL=source.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("monitor/source.ts", { decodeModuleSource })
