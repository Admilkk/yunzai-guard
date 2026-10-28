export const nativeIdentityProtocol = 1;
export const nativeIdentityLimits = {
    frameBytes: 65536,
    stderrBytes: 65536,
    scopeEntries: 256,
    requests: 64,
    maximumBudgetMs: 2147483647,
};
export class NativeIdentityError extends Error {
    code;
    result;
    systemCode;
    /** 创建带拒绝原因码的原生身份错误。 */
    constructor(code, result = "unknown", systemCode) {
        super(`Native process identity: ${code} (${result})`);
        this.code = code;
        this.result = result;
        this.systemCode = systemCode;
        this.name = "NativeIdentityError";
    }
}
//# sourceMappingURL=protocol.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("native-process/protocol.ts", { nativeIdentityProtocol, nativeIdentityLimits, NativeIdentityError })
