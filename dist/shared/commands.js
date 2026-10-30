export const guardCommandPatterns = Object.freeze({
    update: /^#?guard更新$/i,
    "force-update": /^#?guard强制更新$/i,
    rollback: /^#?guard(?:回滚|还原)$/i,
    login: /^#?guard(?:登录|登陆|登入|面板)$/i,
});
const commands = Object.keys(guardCommandPatterns);
/** 识别消息文本对应的命令。 */
export function parseGuardCommand(text) {
    if (typeof text !== "string")
        return undefined;
    return commands.find(command => guardCommandPatterns[command].test(text));
}
//# sourceMappingURL=commands.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("shared/commands.ts", { guardCommandPatterns, parseGuardCommand })
