import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseSettings } from "../config/index.js";
import { loadSandboxSources } from "../plugin-sandbox/filesystem.js";
import { directory, readConfig, parseConfig, unchanged, createFile, removeOwned, maxSettingsBytes, } from "./settings.js";
import { M } from "../shared/messages.js";
const storageDirectory = "data/yunzai-guard-strict";
/** 离线管理配置，不导入或执行业务脚本。 */
export async function sandboxCommand(args, root) {
    const [command = "list", id] = args;
    if (!["list", "check", "init"].includes(command) ||
        args.length > (command === "init" ? 2 : 1) ||
        (command === "init" && !id))
        throw new Error(M.cli.sandboxUsage);
    const state = directory(root, ["data", "yunzai-guard"], false);
    const filename = path.join(state, "settings.json");
    if (command !== "init") {
        const raw = parseConfig(readConfig(filename));
        const settings = parseSettings(raw).pluginSandbox;
        if (command === "list")
            return {
                command,
                plugins: settings.plugins.map(plugin => ({
                    ...plugin,
                    source: `data/yunzai-guard/scripts/${plugin.id}.js`,
                    storage: `${storageDirectory}/${plugin.id}/`,
                })),
            };
        const sources = loadSandboxSources(root, settings);
        return {
            command,
            valid: true,
            scope: "configuration-and-source-files-only",
            executed: false,
            plugins: sources.map(({ id, sha256 }) => ({ id, sha256 })),
        };
    }
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(id) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(id))
        throw new Error(M.cli.pluginIdInvalid);
    directory(root, ["data", "yunzai-guard"], true);
    const lockName = path.join(state, "sandbox-cli.lock");
    let lock;
    try {
        lock = createFile(lockName, `${process.pid}\n`);
    }
    catch (error) {
        if (error.code === "EEXIST")
            throw new Error(M.cli.sandboxLocked);
        throw error;
    }
    const rollback = [];
    try {
        const original = readConfig(filename);
        const raw = parseConfig(original);
        if (Object.hasOwn(raw, "strictJs"))
            throw new Error(M.cli.legacyStrictJs);
        const parsed = parseSettings(raw);
        if (parsed.pluginSandbox.plugins.some(plugin => plugin.id === id))
            throw new Error(M.cli.pluginExists(id));
        const plugin = { id, enabled: true, match: `#${id}*`, capabilities: ["reply"] };
        const sandbox = (raw.pluginSandbox ?? {});
        const updated = {
            ...raw,
            pluginSandbox: { ...sandbox, plugins: [...(sandbox.plugins ?? []), plugin] },
        };
        parseSettings(updated);
        const encoded = `${JSON.stringify(updated, null, 2)}\n`;
        if (Buffer.byteLength(encoded) > maxSettingsBytes)
            throw new Error(M.cli.settingsTooLarge);
        const scripts = directory(root, ["data", "yunzai-guard", "scripts"], true);
        const sourceName = path.join(scripts, `${id}.js`);
        const template = `// 插件沙箱脚本：仅通过 guard API 请求已授权操作。\n// 本模板只授权 reply；文件写入需要在该插件 capabilities 中显式增加 writeText。\nglobalThis.onMessage = event => {\n  guard.reply(${JSON.stringify(`${id} 沙箱运行正常`)})\n}\n`;
        rollback.push(createFile(sourceName, template));
        const suffix = randomUUID();
        const backup = original ? path.join(state, `settings.json.backup-${suffix}`) : undefined;
        if (backup)
            rollback.push(createFile(backup, original));
        const staged = createFile(path.join(state, `.settings-${suffix}.tmp`), encoded);
        rollback.push(staged);
        // CLI 锁保证命令串行；管理期间应停止外部编辑。
        directory(root, ["data", "yunzai-guard"], false);
        directory(root, ["data", "yunzai-guard", "scripts"], false);
        unchanged(filename, original);
        if (original)
            fs.renameSync(staged.name, filename);
        else {
            // 配置不存在时也须独占创建，不能通过重命名覆盖。
            const created = createFile(filename, encoded);
            rollback.push(created);
            removeOwned(staged);
        }
        rollback.length = 0;
        return {
            command,
            plugin,
            source: sourceName,
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
//# sourceMappingURL=sandbox.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("cli/sandbox.ts", { sandboxCommand })
