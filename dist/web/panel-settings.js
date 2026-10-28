import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { M } from "../shared/messages.js";
const maxSettingsBytes = 64 * 1024;
/** 返回面板配置文件路径。 */
export function panelSettingsPath(stateDir) {
    return path.join(stateDir, "panel.json");
}
/** 生成随机密钥。 */
export function randomSecret() {
    return randomBytes(24).toString("base64url");
}
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** 生成指定长度的数字验证码。 */
export function randomCode(length) {
    const bytes = randomBytes(length * 2);
    let result = "";
    for (let index = 0; result.length < length && index < bytes.length; index++) {
        const value = bytes[index];
        if (value >= 256 - (256 % alphabet.length))
            continue;
        result += alphabet[value % alphabet.length];
    }
    return result.length === length ? result : randomSecret().slice(0, length);
}
/** 校验监听地址。 */
function validHost(value) {
    return (typeof value === "string" &&
        value.length <= 255 &&
        (value === "localhost" || net.isIP(value) !== 0));
}
/** 取范围内整数，否则使用默认值。 */
function integer(value, fallback, min, max) {
    return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
        ? value
        : fallback;
}
/** 规范化面板配置并补全默认值。 */
function normalize(value) {
    const source = value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
    return {
        enabled: typeof source.enabled === "boolean" ? source.enabled : true,
        host: validHost(source.host) ? source.host : "0.0.0.0",
        port: integer(source.port, 21733, 1024, 65535),
        tokenTtlHours: integer(source.tokenTtlHours, 24, 1, 720),
        trustedDeviceTtlDays: integer(source.trustedDeviceTtlDays, 30, 1, 90),
        trustProxy: source.trustProxy === true,
        jwtSecret: typeof source.jwtSecret === "string" && source.jwtSecret.length >= 32
            ? source.jwtSecret
            : randomSecret(),
    };
}
/** 原子写入面板配置。 */
function writeSettings(file, settings) {
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    try {
        fs.renameSync(temporary, file);
    }
    finally {
        if (fs.existsSync(temporary))
            fs.rmSync(temporary, { force: true });
    }
}
/** 字段损坏时回落到默认值并立即规范化落盘，避免面板因手改配置而无法启动。 */
export function loadPanelSettings(stateDir) {
    const file = panelSettingsPath(stateDir);
    let raw;
    try {
        const info = fs.statSync(file);
        if (info.isFile() && info.size <= maxSettingsBytes)
            raw = fs.readFileSync(file, "utf8");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    let parsed;
    if (raw !== undefined) {
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            parsed = undefined;
        }
    }
    const settings = normalize(parsed);
    if (raw !== `${JSON.stringify(settings, null, 2)}\n`)
        writeSettings(file, settings);
    return settings;
}
/** 保留 secret，只覆盖面板可调项；非法值直接拒绝。 */
export function savePanelSettings(stateDir, patch) {
    const file = panelSettingsPath(stateDir);
    const next = { ...loadPanelSettings(stateDir) };
    if (patch.host !== undefined) {
        if (!validHost(patch.host))
            throw new TypeError(M.web.host);
        next.host = patch.host;
    }
    if (patch.port !== undefined) {
        if (!Number.isInteger(patch.port) || patch.port < 1024 || patch.port > 65535)
            throw new TypeError(M.web.port);
        next.port = patch.port;
    }
    if (patch.tokenTtlHours !== undefined) {
        if (!Number.isInteger(patch.tokenTtlHours) ||
            patch.tokenTtlHours < 1 ||
            patch.tokenTtlHours > 720)
            throw new TypeError(M.web.tokenTtl);
        next.tokenTtlHours = patch.tokenTtlHours;
    }
    if (patch.enabled !== undefined)
        next.enabled = patch.enabled;
    if (patch.trustedDeviceTtlDays !== undefined) {
        if (!Number.isInteger(patch.trustedDeviceTtlDays) ||
            patch.trustedDeviceTtlDays < 1 ||
            patch.trustedDeviceTtlDays > 90)
            throw new TypeError(M.web.deviceTtl);
        next.trustedDeviceTtlDays = patch.trustedDeviceTtlDays;
    }
    writeSettings(file, next);
    return next;
}
//# sourceMappingURL=panel-settings.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("web/panel-settings.ts", { panelSettingsPath, randomSecret, randomCode, loadPanelSettings, savePanelSettings })
