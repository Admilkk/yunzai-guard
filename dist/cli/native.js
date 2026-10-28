import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseSettings } from "../config/index.js";
import { parseNativeSandbox } from "../native-sandbox/config.js";
import { directory, readConfig, parseConfig, unchanged, createFile, removeOwned, maxSettingsBytes, } from "./settings.js";
import { M } from "../shared/messages.js";
/** 离线选择已有插件，不导入业务、迁移数据或自动授予权限。 */
export async function nativeCommand(args, root) {
    const [command = "list", id] = args;
    const change = command === "enable" || command === "disable";
    if ((!change && !["list", "check"].includes(command)) ||
        args.length > (change ? 2 : 1) ||
        (change && !id))
        throw new Error(M.cli.nativeUsage);
    const state = directory(root, ["data", "yunzai-guard"], false);
    const filename = path.join(state, "settings.json");
    const pluginDirectory = (pluginId) => {
        const target = directory(root, ["plugins", pluginId], false);
        if (!fs.existsSync(target) || !fs.lstatSync(target).isDirectory())
            throw new Error(M.cli.pluginMissing(pluginId));
        return target;
    };
    if (!change) {
        const plugins = parseSettings(parseConfig(readConfig(filename))).pluginSandbox.native.plugins;
        if (command === "list")
            return { command, plugins, source: "configuration-only", executed: false };
        for (const plugin of plugins)
            if (plugin.enabled)
                pluginDirectory(plugin.id);
        return {
            command,
            valid: true,
            scope: "configuration-and-plugin-directories-only",
            executed: false,
            plugins,
        };
    }
    // ID 和权限默认值统一由配置解析器处理，名称不代表授权。
    parseNativeSandbox({ plugins: [{ id }] });
    if (command === "enable")
        pluginDirectory(id);
    directory(root, ["data", "yunzai-guard"], true);
    let lock;
    try {
        lock = createFile(path.join(state, "sandbox-cli.lock"), `${process.pid}\n`);
    }
    catch (error) {
        if (error.code === "EEXIST")
            throw Object.assign(new Error(M.cli.sandboxLocked), { code: "EEXIST" });
        throw error;
    }
    const rollback = [];
    try {
        const original = readConfig(filename), raw = parseConfig(original);
        const sandbox = (raw.pluginSandbox ?? {});
        const native = (sandbox.native ?? {});
        const plugins = [...(native.plugins ?? [])];
        const index = plugins.findIndex(plugin => plugin.id === id);
        if (index < 0 && command === "disable")
            throw new Error(M.cli.nativeUnconfigured(id));
        const enabled = command === "enable";
        if (index >= 0 && (plugins[index].enabled ?? true) === enabled)
            return { command, id, changed: false, restartRequired: false };
        const selection = { ...(index < 0 ? { id } : plugins[index]), enabled };
        if (index < 0)
            plugins.push(selection);
        else
            plugins[index] = selection;
        const updated = { ...raw, pluginSandbox: { ...sandbox, native: { ...native, plugins } } };
        parseSettings(updated);
        const encoded = `${JSON.stringify(updated, null, 2)}\n`;
        if (Buffer.byteLength(encoded) > maxSettingsBytes)
            throw new Error(M.cli.settingsTooLarge);
        const suffix = randomUUID(), backup = original ? path.join(state, `settings.json.backup-${suffix}`) : undefined;
        if (backup)
            rollback.push(createFile(backup, original));
        const staged = createFile(path.join(state, `.settings-${suffix}.tmp`), encoded);
        rollback.push(staged);
        directory(root, ["data", "yunzai-guard"], false);
        unchanged(filename, original);
        if (original)
            fs.renameSync(staged.name, filename);
        else {
            rollback.push(createFile(filename, encoded));
            removeOwned(staged);
        }
        rollback.length = 0;
        return {
            command,
            id,
            changed: true,
            settings: filename,
            ...(backup ? { backup } : {}),
            restartRequired: true,
        };
    }
    catch (error) {
        for (const file of rollback.reverse())
            removeOwned(file);
        throw error;
    }
    finally {
        removeOwned(lock);
    }
}
//# sourceMappingURL=native.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("cli/native.ts", { nativeCommand })
