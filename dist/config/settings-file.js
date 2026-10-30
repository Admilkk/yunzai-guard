import fs from "node:fs";
import path from "node:path";
import { Document, isMap, isScalar, isSeq, parseDocument, YAMLMap } from "./yaml.js";
import { helpForPath } from "../shared/setting-help.js";
import { writeTextFile } from "../shared/files.js";
import { M } from "../shared/messages.js";
/**
 * 配置文件：
 * - settings.yaml 由用户编辑，只写要改的项，可写注释；Guard 修改时保留注释、顺序与格式。
 * - settings.default.yaml 每次宿主启动按当前版本重写，列出全部配置项、默认值与说明，只作参考。
 * - settings.json 是旧版本使用的格式：首次启动时转换为 settings.yaml，之后作为镜像保留，
 *   供回退到不支持 YAML 的旧版本时读取。
 */
export const settingsFiles = Object.freeze({
    user: "settings.yaml",
    defaults: "settings.default.yaml",
    legacy: "settings.json",
});
export const maxSettingsBytes = 1024 * 1024;
const userHeader = [
    " Yunzai Guard 配置",
    " 只需写要修改的项，没写的项使用当前版本的默认值；全部配置项、默认值与说明见同目录的 settings.default.yaml。",
    " 直接修改本文件后需重启机器人才会生效；在 Web 控制台的“设置”页修改可立即生效，并会保留这里的注释与顺序。",
    " settings.json 由 Guard 自动生成，仅供回退到旧版本时读取，请勿编辑。",
].join("\n");
const defaultsHeader = [
    " Yunzai Guard 全部配置项与默认值，由 Guard 在每次启动时重新生成，修改本文件不会生效。",
    " 需要调整的项请复制到同目录的 settings.yaml，只写要改的部分即可。",
].join("\n");
/** 字段说明之外的分组与列表说明。 */
const notes = Object.freeze({
    schemaVersion: "配置格式版本，请勿修改。",
    rules: "拦截规则，自上而下匹配，第一条命中的规则生效；建议在 Web 控制台的“规则”页编辑。",
    monitor: "监控范围。",
    sandbox: "系统沙箱，仅在 isolationMode 为 os-sandbox 时生效。",
    recovery: "业务进程异常退出后的自动恢复；时间窗内重启次数超过上限即熔断，需手动解除。",
    audit: "审计日志。",
    log: "宿主日志 host.log。",
    update: "版本检查与自动更新。",
    alerts: "告警推送：私聊主人与 Webhook。",
    "alerts.on": "按类别开关告警。",
    "alerts.on.deny": "插件操作被拦截。",
    "alerts.on.restart": "触发重启规则。",
    "alerts.on.tripped": "业务进程熔断。",
    "alerts.on.integrity": "受保护函数被改动。",
    "alerts.on.anomaly": "插件行为偏离基线。",
    "alerts.on.source": "插件文件或 Git 来源变化。",
    "alerts.on.update": "发现新版本与更新结果。",
    "alerts.on.security": "控制台登录与访问相关事件。",
    "alerts.webhook": "把告警转发到 Webhook。",
    "alerts.webhook.format": "推送格式：json 或 text。",
    "alerts.forward": "除告警外，额外转发到 Webhook 的审计事件。",
    "alerts.throttle": "告警限流：时间窗内同类告警超过上限后合并为一条摘要。",
    baseline: "行为基线：学习插件的正常行为，出现偏离时告警。",
    "baseline.spike": "频率突增检测。",
    "baseline.burst": "短时间内批量出现新目标的检测。",
    sources: "插件来源校验：定期比对插件目录与其 Git 仓库，发现文件或来源被改动时提醒。",
    "sources.notify": "按变化类型开关提醒。",
    protect: "关键函数完整性观察。",
    pluginSandbox: "受限脚本沙箱：data/yunzai-guard/scripts 下的脚本只能通过授权的接口操作。",
    "pluginSandbox.plugins": "受限脚本列表，可执行 node plugins/yunzai-guard/dist/cli.js sandbox init <id> 添加。",
    "pluginSandbox.native": "原生插件沙箱：选定的插件在独立进程中运行。",
    "pluginSandbox.native.plugins": "放入独立进程的插件，可执行 node plugins/yunzai-guard/dist/cli.js native enable <目录名> 添加。",
});
/** 按字段名补充单位。 */
function unit(key) {
    if (/(?:Ms|Timeout)$/.test(key))
        return "单位：毫秒。";
    if (key.endsWith("Bytes"))
        return "单位：字节。";
    if (key.endsWith("MiB"))
        return "单位：MiB。";
    return "";
}
/** 某个配置路径的注释文本。 */
export function settingNote(keys) {
    // 控制台说明里的“保存后立即生效”只适用于控制台；直接改文件需重启宿主，不写入注释。
    const text = [notes[keys.join(".")] ?? helpForPath(keys)?.description, unit(keys.at(-1))]
        .filter(Boolean)
        .join("");
    return text || undefined;
}
/** 判断为普通对象。 */
const plain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** 结构相等。 */
function same(a, b) {
    if (Object.is(a, b))
        return true;
    if (Array.isArray(a) && Array.isArray(b))
        return a.length === b.length && a.every((item, index) => same(item, b[index]));
    if (plain(a) && plain(b)) {
        const keys = Object.keys(a);
        return keys.length === Object.keys(b).length && keys.every(key => same(a[key], b[key]));
    }
    return false;
}
/** 去掉与默认值相同的项；全部相同时返回 undefined。 */
function difference(value, fallback) {
    if (!plain(value) || !plain(fallback))
        return same(value, fallback) ? undefined : value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
        const reduced = difference(item, fallback[key]);
        if (reduced !== undefined)
            result[key] = reduced;
    }
    return Object.keys(result).length ? result : undefined;
}
const stringifyOptions = { lineWidth: 0, flowCollectionPadding: false };
/** 键名文本。 */
const keyText = (key) => String(isScalar(key) ? key.value : key);
/** 给节点下的每个键补上说明；短的纯值列表改用单行写法。 */
function annotate(node, keys) {
    if (isSeq(node)) {
        if (node.items.every(item => isScalar(item)) &&
            JSON.stringify(node.toJSON()).length <= 80 &&
            node.items.length)
            node.flow = true;
        return;
    }
    if (!isMap(node))
        return;
    for (const pair of node.items) {
        const path = [...keys, keyText(pair.key)];
        const text = settingNote(path);
        if (text && isScalar(pair.key) && !pair.key.commentBefore)
            pair.key.commentBefore = ` ${text}`;
        // 顶层分组之间空一行。
        if (!keys.length && isScalar(pair.key) && pair !== node.items[0])
            pair.key.spaceBefore = true;
        annotate(pair.value, path);
    }
}
/** 默认配置文件文本：全部配置项、默认值与说明。 */
export function defaultSettingsText(defaults) {
    const document = new Document(defaults);
    document.commentBefore = defaultsHeader;
    annotate(document.contents, []);
    return document.toString(stringifyOptions);
}
/** 新建的用户配置文件：只有说明，所有项取默认值。 */
export function starterSettingsText() {
    return `${userHeader
        .split("\n")
        .map(line => `#${line}`)
        .join("\n")}\n`;
}
/** 把用户配置对象同步进 YAML 映射：只改变化的值，保留原有注释。 */
function sync(document, map, value, fallback, keys, omitDefaults) {
    for (const pair of [...map.items])
        if (!Object.hasOwn(value, keyText(pair.key)))
            map.delete(pair.key);
    for (const [key, next] of Object.entries(value)) {
        const path = [...keys, key];
        const current = map.get(key, true);
        const base = plain(fallback) ? fallback[key] : undefined;
        if (plain(next) && isMap(current)) {
            sync(document, current, next, plain(base) ? base : undefined, path, omitDefaults);
            continue;
        }
        if (current === undefined) {
            const added = omitDefaults ? difference(next, base) : next;
            if (added === undefined)
                continue;
            const node = document.createNode(added);
            annotate(node, path);
            const pair = document.createPair(key, node);
            const text = settingNote(path);
            if (text && isScalar(pair.key))
                pair.key.commentBefore = ` ${text}`;
            if (!keys.length && map.items.length && isScalar(pair.key))
                pair.key.spaceBefore = true;
            map.items.push(pair);
            continue;
        }
        if (same(current.toJSON(), next))
            continue;
        const node = document.createNode(next);
        annotate(node, path);
        node.comment = current.comment;
        map.set(key, node);
    }
}
/**
 * 生成用户配置文本。previous 为原文时保留其注释、顺序与格式，只改变化的值；
 * omitDefaults 为真时不新增与默认值相同的项，避免把当前默认值固定在用户文件里。
 */
export function renderSettings(value, options = {}) {
    let document = parseDocument(options.previous ?? starterSettingsText());
    if (document.errors.length)
        document = parseDocument(starterSettingsText());
    if (!isMap(document.contents)) {
        // 只有注释的文档没有内容节点，注释记在文档末尾，挪到开头。
        document.commentBefore ??= document.comment ?? userHeader;
        document.comment = null;
        document.contents = new YAMLMap();
    }
    sync(document, document.contents, value, options.defaults, [], options.omitDefaults === true);
    return document.toString(stringifyOptions);
}
/** 解析配置文本，YAML 兼容 JSON；空文档视为空对象。 */
export function parseSettingsText(text, name = settingsFiles.user) {
    const document = parseDocument(text, { uniqueKeys: true, prettyErrors: true });
    const [error] = document.errors;
    if (error)
        throw new TypeError(M.config.yamlSyntax(name, error.message));
    const value = document.toJS();
    if (value === null || value === undefined)
        return {};
    if (!plain(value))
        throw new TypeError(M.config.yamlRoot(name));
    return value;
}
/** 读取配置原文；不存在时返回 undefined。 */
function readText(file, format) {
    let bytes;
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > maxSettingsBytes)
            throw new TypeError(M.config.fileSize(path.basename(file)));
        bytes = fs.readFileSync(file);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.charCodeAt(0) !== 0xfeff)
        return text;
    // 记事本等编辑器保存的 YAML 常带 BOM；旧版 JSON 保持原有的严格要求。
    if (format === "json")
        throw new TypeError(M.config.encoding);
    return text.slice(1);
}
/** 读取用户配置：优先 settings.yaml，其次旧版 settings.json。 */
export function readSettingsSource(stateDir) {
    for (const [name, format] of [
        [settingsFiles.user, "yaml"],
        [settingsFiles.legacy, "json"],
    ]) {
        const file = path.join(stateDir, name);
        const text = readText(file, format);
        if (text !== undefined)
            return { file, format, text };
    }
    return undefined;
}
/** 解析读取到的用户配置。 */
export function parseSettingsSource(source) {
    if (source.format === "yaml")
        return parseSettingsText(source.text);
    const value = JSON.parse(source.text);
    if (!plain(value))
        throw new TypeError(M.config.yamlRoot(settingsFiles.legacy));
    return value;
}
/** 镜像文件的文本，格式与旧版本保存的 settings.json 一致。 */
function mirrorText(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}
/** 写入旧版本回退用的 settings.json 镜像。 */
export function writeLegacyMirror(stateDir, value) {
    writeTextFile(path.join(stateDir, settingsFiles.legacy), mirrorText(value));
}
/** 原子写入用户配置，并同步 settings.json 镜像；镜像失败不影响配置本身。 */
export function writeSettingsText(stateDir, text) {
    if (Buffer.byteLength(text) > maxSettingsBytes)
        throw new TypeError(M.config.fileSize(settingsFiles.user));
    const value = parseSettingsText(text);
    writeTextFile(path.join(stateDir, settingsFiles.user), text);
    try {
        writeLegacyMirror(stateDir, value);
    }
    catch {
        // 下次宿主启动时会重新同步。
    }
}
/** 内容不同才写入，避免每次启动都改动文件时间。 */
function writeIfChanged(file, text) {
    try {
        if (fs.readFileSync(file, "utf8") === text)
            return;
    }
    catch {
        // 文件不存在。
    }
    writeTextFile(file, text);
}
/**
 * 宿主启动时整理配置文件：重写默认配置；只有 settings.json 时转换为 settings.yaml（原文件保留为镜像）；
 * 都没有时创建只含说明的 settings.yaml；之后按需刷新镜像。返回需要提示用户的信息。
 * 任何一步失败都不影响随后按原文件读取配置。
 */
export function prepareSettingsFiles(stateDir, defaults) {
    const notices = [];
    const user = path.join(stateDir, settingsFiles.user);
    const legacy = path.join(stateDir, settingsFiles.legacy);
    try {
        writeIfChanged(path.join(stateDir, settingsFiles.defaults), defaultSettingsText(defaults));
    }
    catch {
        // 默认配置只是参考文件。
    }
    try {
        const text = readText(user, "yaml");
        if (text === undefined) {
            const json = readText(legacy, "json");
            const value = json === undefined ? undefined : JSON.parse(json);
            if (json !== undefined && !plain(value))
                return notices;
            const converted = plain(value)
                ? renderSettings(value, { defaults, omitDefaults: false })
                : starterSettingsText();
            if (Buffer.byteLength(converted) > maxSettingsBytes) {
                notices.push(M.config.migrationTooLarge);
                return notices;
            }
            writeTextFile(user, converted);
            if (json !== undefined)
                notices.push(M.config.migrated);
            return notices;
        }
        const value = parseSettingsText(text);
        const legacyText = readText(legacy, "json");
        if (legacyText === undefined) {
            if (Object.keys(value).length)
                writeLegacyMirror(stateDir, value);
        }
        else if (fs.statSync(user).mtimeMs >= fs.statSync(legacy).mtimeMs) {
            writeIfChanged(legacy, mirrorText(value));
        }
        else if (!same(JSON.parse(legacyText), value)) {
            // settings.json 比 settings.yaml 新且内容不同：多半是按旧习惯改了 settings.json。
            notices.push(M.config.legacyEdited);
        }
    }
    catch {
        // 配置有误时由随后的读取报告具体错误。
    }
    return notices;
}
//# sourceMappingURL=settings-file.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("config/settings-file.ts", { settingsFiles, maxSettingsBytes, settingNote, defaultSettingsText, starterSettingsText, renderSettings, parseSettingsText, readSettingsSource, parseSettingsSource, writeLegacyMirror, writeSettingsText, prepareSettingsFiles })
