const minimum = [5n, 0n, 0n];
/**
 * 接受 >= 5.0.0 的任意 SemVer，包括更高版本的预发布号（如 7.1.0-rc.1）；
 * 5.0.0 自身的预发布号早于正式版，仍拒绝。版本号只是门槛，
 * 守护进程结构与身份仍须另行检查。
 */
export function isSupportedPm2Version(value) {
    if (typeof value !== "string" || value.length > 128)
        return false;
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
    if (!match || match[0] !== value)
        return false;
    const core = [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])];
    for (let index = 0; index < 3; index++) {
        if (core[index] > minimum[index])
            return true;
        if (core[index] < minimum[index])
            return false;
    }
    return match[4] === undefined;
}
//# sourceMappingURL=versions.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("pm2/versions.ts", { isSupportedPm2Version })
