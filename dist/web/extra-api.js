import os from "node:os";
import { parseSettings } from "../config/index.js";
import { M } from "../shared/messages.js";
import { isPlainObject, listSettingsBackups, readSettingsBackup, readSettingsDocument, validateSettingsDocument, writeSettingsDocument, } from "./guard-settings.js";
import { readAudit } from "./monitor.js";
const maxExportRows = 20000;
/** 转成 CSV 字段，处理引号、换行，并防止被表格软件当作公式。 */
function csvField(value) {
    let text = value === undefined || value === null ? "" : String(value);
    if (/^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/.test(text))
        text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
/** 把审计条目转为一行 CSV。 */
function csvRow(entry) {
    return [
        new Date(entry.time).toISOString(),
        entry.plugin,
        entry.kind,
        entry.operation,
        entry.target,
        entry.action,
        entry.ruleId,
        entry.blocked ? "是" : "",
    ]
        .map(csvField)
        .join(",");
}
/** 设置导出时去掉 Webhook 密钥，除非明确要求带上。 */
function exportable(document, secrets) {
    if (secrets)
        return document;
    const alerts = document.alerts;
    if (!isPlainObject(alerts) || !isPlainObject(alerts.webhook))
        return document;
    return { ...document, alerts: { ...alerts, webhook: { ...alerts.webhook, secret: "" } } };
}
/** 面板扩展接口；未处理的路由返回 false。 */
export async function handleExtra(context, route, url, request, response) {
    const { stateDir, controllers, sendJson, fail } = context;
    const active = () => context.getSettings?.() ?? context.settings;
    if (route === "GET /api/alerts") {
        if (!controllers)
            throw fail(404, M.web.notFound);
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));
        sendJson(response, 200, { history: controllers.alerts.history(limit) });
        return true;
    }
    if (route === "GET /api/alerts/state") {
        if (!controllers)
            throw fail(404, M.web.notFound);
        sendJson(response, 200, controllers.alerts.state());
        return true;
    }
    if (route === "POST /api/alerts/ack") {
        if (!controllers)
            throw fail(404, M.web.notFound);
        const body = await context.readBody(request);
        const ids = isPlainObject(body) && Array.isArray(body.ids)
            ? body.ids.filter((id) => typeof id === "string").slice(0, 200)
            : undefined;
        controllers.alerts.acknowledge(ids);
        sendJson(response, 200, { ok: true, state: controllers.alerts.state() });
        return true;
    }
    if (route === "POST /api/alerts/mute") {
        if (!controllers)
            throw fail(404, M.web.notFound);
        const body = await context.readBody(request);
        const input = isPlainObject(body) ? body : {};
        const plugin = typeof input.plugin === "string" ? input.plugin.slice(0, 128) : "";
        const category = typeof input.category === "string" ? input.category : "";
        const minutes = Number(input.minutes);
        if ((!plugin && !category) ||
            !Number.isInteger(minutes) ||
            minutes < 1 ||
            minutes > 30 * 24 * 60)
            throw fail(400, M.web.bodyObject);
        controllers.alerts.mute(plugin
            ? { plugin }
            : { category: category }, minutes);
        context.audit?.("panel-alert-muted", { plugin, category, minutes });
        sendJson(response, 200, { ok: true, state: controllers.alerts.state() });
        return true;
    }
    if (route === "POST /api/alerts/unmute") {
        if (!controllers)
            throw fail(404, M.web.notFound);
        const body = await context.readBody(request);
        controllers.alerts.unmute(isPlainObject(body) ? String(body.key).slice(0, 200) : "");
        sendJson(response, 200, { ok: true, state: controllers.alerts.state() });
        return true;
    }
    if (route === "GET /api/resources") {
        if (!controllers)
            throw fail(404, M.web.notFound);
        const memory = process.memoryUsage();
        sendJson(response, 200, {
            points: controllers.resources.points(),
            system: {
                platform: process.platform,
                totalMemory: os.totalmem(),
                freeMemory: os.freemem(),
                cpus: os.cpus().length,
                load: os.loadavg(),
                uptime: os.uptime(),
            },
            host: {
                pid: process.pid,
                rss: memory.rss,
                heapUsed: memory.heapUsed,
                heapTotal: memory.heapTotal,
                external: memory.external,
                uptime: process.uptime(),
            },
        });
        return true;
    }
    if (route === "POST /api/alerts/test") {
        if (!controllers)
            throw fail(404, M.web.notFound);
        sendJson(response, 200, await controllers.alerts.testWebhook());
        return true;
    }
    if (route === "GET /api/profiles") {
        if (!controllers)
            throw fail(404, M.web.notFound);
        sendJson(response, 200, controllers.profiles.summary());
        return true;
    }
    if (route === "GET /api/profiles/detail") {
        if (!controllers)
            throw fail(404, M.web.notFound);
        const detail = controllers.profiles.detail(url.searchParams.get("plugin") ?? "");
        if (!detail)
            throw fail(404, M.web.notFound);
        sendJson(response, 200, detail);
        return true;
    }
    if (controllers &&
        ["trust", "forget", "end", "reset"].some(name => route === `POST /api/profiles/${name}`)) {
        const body = await context.readBody(request);
        const input = isPlainObject(body) ? body : {};
        const plugin = typeof input.plugin === "string" ? input.plugin.slice(0, 128) : undefined;
        const kind = typeof input.kind === "string" ? input.kind.slice(0, 64) : "";
        const key = typeof input.key === "string" ? input.key.slice(0, 256) : "";
        const action = route.slice("POST /api/profiles/".length);
        let ok = true;
        if (action === "trust" || action === "forget") {
            if (!plugin || !kind || !key)
                throw fail(400, M.web.bodyObject);
            ok =
                action === "trust"
                    ? controllers.profiles.trust(plugin, kind, key)
                    : controllers.profiles.forget(plugin, kind, key);
        }
        else if (action === "end")
            controllers.profiles.endLearning(plugin);
        else
            controllers.profiles.reset(plugin);
        context.audit?.("panel-profile-action", { action, plugin });
        sendJson(response, 200, { ok });
        return true;
    }
    if (route === "GET /api/sources") {
        if (!controllers)
            throw fail(404, M.web.notFound);
        sendJson(response, 200, { sources: controllers.sources.list() });
        return true;
    }
    if (route === "POST /api/sources/scan") {
        if (!controllers)
            throw fail(404, M.web.notFound);
        sendJson(response, 200, { sources: await controllers.sources.scan() });
        return true;
    }
    if (route === "GET /api/settings/backups") {
        sendJson(response, 200, { backups: listSettingsBackups(stateDir) });
        return true;
    }
    if (route === "GET /api/settings/backup") {
        const text = readSettingsBackup(stateDir, url.searchParams.get("id") ?? "");
        if (text === undefined)
            throw fail(404, M.web.notFound);
        sendJson(response, 200, { document: JSON.parse(text) });
        return true;
    }
    if (route === "POST /api/settings/restore") {
        const body = await context.readBody(request);
        context.checkSettingsRevision(body);
        const text = readSettingsBackup(stateDir, isPlainObject(body) ? String(body.id) : "");
        if (text === undefined)
            throw fail(404, M.web.notFound);
        const value = JSON.parse(text);
        const normalized = validateSettingsDocument(stateDir, value);
        const result = writeSettingsDocument(stateDir, active(), value);
        context.audit?.("panel-settings-restored", { pendingRestart: result.pendingRestart });
        const apply = context.applySettings?.(normalized);
        sendJson(response, 200, { ok: true, ...result, apply });
        return true;
    }
    if (route === "GET /api/settings/export") {
        const document = readSettingsDocument(stateDir, active()).document;
        const scope = url.searchParams.get("scope");
        const body = scope === "rules"
            ? { rules: document.rules ?? [] }
            : exportable(document, url.searchParams.get("secrets") === "1");
        const file = scope === "rules" ? "guard-rules.json" : "guard-settings.json";
        response.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="${file}"`,
            "Cache-Control": "no-store",
        });
        response.end(`${JSON.stringify(body, null, 2)}\n`);
        return true;
    }
    if (route === "POST /api/settings/import-rules") {
        const body = await context.readBody(request);
        context.checkSettingsRevision(body);
        if (!isPlainObject(body) ||
            !Array.isArray(body.rules) ||
            body.rules.some(rule => !isPlainObject(rule)))
            throw fail(400, M.web.bodyObject);
        const current = readSettingsDocument(stateDir, active()).document;
        const existing = Array.isArray(current.rules)
            ? current.rules
            : [];
        const used = new Set(existing.map(rule => String(rule.id)));
        const imported = body.rules.map(rule => {
            let id = String(rule?.id ?? "rule");
            if (body.mode !== "replace")
                for (let index = 2; used.has(id); index++)
                    id = `${String(rule?.id ?? "rule")}-${index}`;
            used.add(id);
            return { ...rule, id };
        });
        const document = {
            ...current,
            rules: body.mode === "replace" ? imported : [...existing, ...imported],
        };
        const normalized = parseSettings(document);
        const result = writeSettingsDocument(stateDir, active(), document);
        context.audit?.("panel-rules-imported", { count: imported.length, mode: body.mode });
        const apply = context.applySettings?.(normalized);
        sendJson(response, 200, { ok: true, imported: imported.length, ...result, apply });
        return true;
    }
    if (route === "GET /api/audit/export") {
        const format = url.searchParams.get("format") === "json" ? "json" : "csv";
        const params = new URLSearchParams(url.searchParams);
        params.delete("format");
        params.delete("limit");
        params.set("pageSize", "100");
        const limit = Math.min(maxExportRows, Math.max(1, Number(url.searchParams.get("limit")) || 5000));
        const entries = [];
        for (let page = 1; entries.length < limit; page++) {
            params.set("page", String(page));
            const result = readAudit(stateDir, params);
            entries.push(...result.items);
            if (!result.hasMore)
                break;
        }
        const rows = entries.slice(0, limit);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        response.writeHead(200, {
            "Content-Type": format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="guard-audit-${stamp}.${format}"`,
            "Cache-Control": "no-store",
        });
        context.audit?.("panel-audit-exported", { format, rows: rows.length });
        if (format === "json")
            response.end(`${JSON.stringify(rows, null, 2)}\n`);
        else
            response.end(`\uFEFF时间,插件,类型,行为,目标,处理,规则,已拦截\r\n${rows.map(csvRow).join("\r\n")}\r\n`);
        return true;
    }
    void request;
    return false;
}
//# sourceMappingURL=extra-api.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("web/extra-api.ts", { handleExtra })
