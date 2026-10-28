export const defaultTargets = Object.freeze([
    "Bot.sendFriendMsg",
    "Bot.sendGroupMsg",
    "Bot.sendMasterMsg",
    "Bot.sendForwardMsg",
    "Bot.fileToUrl",
    "Bot.serverAuth",
    "Bot.exitEvent",
    "PluginsLoader.load",
    "PluginsLoader.importPlugin",
    "PluginsLoader.loadPlugin",
    "PluginsLoader.unloadPlugin",
    "PluginsLoader.changePlugin",
    "PluginsLoader.registerHandlers",
    "PluginsLoader.dealEvent",
    "PluginsLoader.filtPermission",
    "PluginsLoader.checkBlack",
    "PluginsLoader.checkDisable",
    "PluginsLoader.checkLimit",
    "PluginsLoader.collectTask",
    "PluginsLoader.startTask",
    "Global.plugin.prototype.reply",
    "Global.plugin.prototype.renderImg",
]);
//# sourceMappingURL=targets.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("config/targets.ts", { defaultTargets })
