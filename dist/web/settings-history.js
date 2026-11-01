import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { parseSettings } from "../config/index.js";
import { parseSettingsText, readSettingsSource } from "../config/settings-file.js";
import { planSettingsUpdate } from "../config/update.js";
import { isOrdinaryFile, readJsonFile, writeJsonFile, writeTextFile } from "../shared/files.js";
import { sha256 } from "../shared/hash.js";
const keep = 30;
const maxTextBytes = 1024 * 1024;
const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^\d{13}-[a-f0-9]{12}$/;
const backupPattern = /^settings-[\w-]+\.(?:json|yaml)$/;
const snapshotPattern = /^[a-f0-9]{64}\.yaml$/;
const epoch = `${process.pid}:${randomBytes(12).toString("hex")}`;
const previewKey = randomBytes(32);
const sensitive = /secret|token|password|authorization|cookie|credential|private.?key|access.?key/i;
/** 元数据只记录变化路径；配置原文沿用历史备份及有界快照。 */
function indexPath(stateDir) {
    return path.join(stateDir, "settings-operations.json");
}
function snapshots(stateDir) {
    return path.join(stateDir, "settings-operation-snapshots");
}
function referencePath(stateDir, reference) {
    if ("backup" in reference && backupPattern.test(reference.backup))
        return path.join(stateDir, "settings-history", reference.backup);
    if ("snapshot" in reference && snapshotPattern.test(reference.snapshot))
        return path.join(snapshots(stateDir), reference.snapshot);
    throw new TypeError("操作记录无效");
}
function readReference(stateDir, reference) {
    const file = referencePath(stateDir, reference);
    try {
        if (!isOrdinaryFile(fs.lstatSync(file), maxTextBytes))
            return undefined;
        return fs.readFileSync(file, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
function referenceAvailable(stateDir, reference) {
    try {
        return isOrdinaryFile(fs.lstatSync(referencePath(stateDir, reference)), maxTextBytes);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}
function validReference(value) {
    if (!value || typeof value !== "object")
        return false;
    return (("backup" in value && typeof value.backup === "string" && backupPattern.test(value.backup)) ||
        ("snapshot" in value &&
            typeof value.snapshot === "string" &&
            snapshotPattern.test(value.snapshot)));
}
function readIndex(stateDir) {
    const value = readJsonFile(indexPath(stateDir), maxTextBytes);
    if (value === undefined)
        return [];
    if (!Array.isArray(value) ||
        value.length > keep ||
        value.some(item => !item ||
            typeof item !== "object" ||
            !idPattern.test(item.id) ||
            typeof item.title !== "string" ||
            item.title.length > 120 ||
            !Number.isSafeInteger(item.time) ||
            !hashPattern.test(item.revision) ||
            !hashPattern.test(item.beforeRevision) ||
            !validReference(item.before) ||
            !validReference(item.after) ||
            !["unknown", "applying", "applied", "failed", "pending-restart"].includes(item.status) ||
            !Array.isArray(item.paths) ||
            item.paths.length > 200 ||
            item.paths.some((field) => typeof field !== "string" || field.length > 200)))
        throw new TypeError("操作记录无效");
    return value;
}
function saveIndex(stateDir, records) {
    writeJsonFile(indexPath(stateDir), records.slice(0, keep));
    const retained = new Set(records
        .slice(0, keep)
        .flatMap(item => [item.before, item.after])
        .flatMap(reference => ("snapshot" in reference ? [reference.snapshot] : [])));
    let names;
    try {
        names = fs.readdirSync(snapshots(stateDir));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return;
        throw error;
    }
    for (const name of names)
        if (snapshotPattern.test(name) && !retained.has(name))
            fs.unlinkSync(path.join(snapshots(stateDir), name));
}
function snapshot(stateDir, text) {
    const name = `${sha256(text)}.yaml`;
    const reference = { snapshot: name };
    if (readReference(stateDir, reference) !== text)
        writeTextFile(referencePath(stateDir, reference), text);
    return reference;
}
function object(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function masked(value, key, depth = 0) {
    if (sensitive.test(key) || key === "webhook")
        return "[已隐藏]";
    if (depth > 5)
        return "…";
    if (typeof value === "string")
        return value.length > 160 ? `${value.slice(0, 160)}…` : value;
    if (Array.isArray(value))
        return value.slice(0, 12).map(item => masked(item, "", depth + 1));
    if (object(value))
        return Object.fromEntries(Object.entries(value)
            .slice(0, 16)
            .map(([name, item]) => [name, masked(item, name, depth + 1)]));
    return value;
}
/** 返回有限、脱敏的差异摘要；列表仅使用其中的路径。 */
export function settingsHistoryChanges(before, after) {
    const changes = [];
    let nodes = 50000;
    const visit = (left, right, field, depth = 0) => {
        if (--nodes < 0 || changes.length >= 200)
            return;
        if (JSON.stringify(left) === JSON.stringify(right))
            return;
        if (depth < 24 && object(left) && object(right)) {
            for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
                const next = field ? `${field}.${key}` : key;
                if (sensitive.test(key) || key === "webhook") {
                    if (JSON.stringify(left[key]) !== JSON.stringify(right[key]))
                        changes.push({ path: next.slice(0, 200), before: "[已隐藏]", after: "[已隐藏]" });
                }
                else
                    visit(left[key], right[key], next, depth + 1);
            }
            return;
        }
        changes.push({
            path: (field || "settings.yaml").slice(0, 200),
            before: masked(left, field),
            after: masked(right, field),
        });
    };
    visit(before, after, "");
    return changes;
}
function parsed(text) {
    try {
        return parseSettings(parseSettingsText(text));
    }
    catch {
        return undefined;
    }
}
/** 原值重试复用最近一次实际修改，保留原始撤销范围和操作信息。 */
export function reusableSettingsOperation(stateDir, revision) {
    const record = readIndex(stateDir)[0];
    return record?.revision === revision ? publicRecord(stateDir, record, revision, true) : undefined;
}
/** 每次实际写入后登记；同一份原文只保留一个快照。 */
export function recordSettingsOperation(stateDir, options) {
    if (options.beforeText === options.afterText)
        return reusableSettingsOperation(stateDir, sha256(options.afterText));
    const records = readIndex(stateDir);
    const beforeSettings = parsed(options.beforeText);
    const afterSettings = parsed(options.afterText);
    const time = Date.now();
    const before = options.backupId && backupPattern.test(options.backupId)
        ? { backup: options.backupId }
        : snapshot(stateDir, options.beforeText);
    const record = {
        id: `${time}-${randomBytes(6).toString("hex")}`,
        title: (options.title?.trim() || "保存配置").slice(0, 120),
        time,
        beforeRevision: sha256(options.beforeText),
        revision: sha256(options.afterText),
        before,
        after: snapshot(stateDir, options.afterText),
        beforeValid: beforeSettings !== undefined,
        status: "unknown",
        paths: settingsHistoryChanges(beforeSettings, afterSettings).map(change => change.path),
    };
    for (const previous of records)
        if (previous.status === "applying") {
            previous.status = "unknown";
            previous.superseded = true;
        }
    records.unshift(record);
    saveIndex(stateDir, records);
    return publicRecord(stateDir, record, record.revision, true);
}
function publicRecord(stateDir, record, currentRevision, latest) {
    const canRestoreBefore = record.beforeRevision !== record.revision &&
        record.beforeValid &&
        referenceAvailable(stateDir, record.before);
    return {
        id: record.id,
        title: record.title,
        time: record.time,
        beforeRevision: record.beforeRevision,
        revision: record.revision,
        status: record.status,
        changes: record.paths.map(field => ({ path: field })),
        canUndo: latest && record.revision === currentRevision && canRestoreBefore,
        canRestoreBefore,
        canRestore: record.status === "applied" && referenceAvailable(stateDir, record.after),
    };
}
/** 关联控制器真实代次；后续请求会使未确认完成的旧请求变成未知。 */
export function applySettingsOperation(stateDir, id, apply, currentRevision) {
    const records = readIndex(stateDir);
    const record = records.find(item => item.id === id);
    if (!record)
        return undefined;
    if (apply) {
        record.status = apply.status;
        record.applyRevision = apply.revision;
        record.epoch = epoch;
    }
    saveIndex(stateDir, records);
    if (currentRevision === undefined) {
        try {
            currentRevision = sha256(readSettingsSource(stateDir)?.text ?? "");
        }
        catch {
            currentRevision = "";
        }
    }
    return publicRecord(stateDir, record, currentRevision, records[0] === record);
}
/** 只确认与当前文件、实际活动配置及控制器代次一致的结果。 */
export function listSettingsOperations(stateDir, currentText, active, apply) {
    const records = readIndex(stateDir);
    const currentRevision = sha256(currentText);
    const record = records.find(item => item.revision === currentRevision);
    let changed = false;
    if (record && apply) {
        if (record.epoch === epoch && record.applyRevision === apply.revision) {
            if (record.status !== apply.status) {
                record.status = apply.status;
                changed = true;
            }
        }
        else if (record.epoch !== epoch && !record.superseded && apply.status === "applied") {
            const text = readReference(stateDir, record.after);
            const desired = text === undefined || sha256(text) !== record.revision ? undefined : parsed(text);
            if (desired &&
                JSON.stringify(desired) === JSON.stringify(active) &&
                record.status !== "applied") {
                record.status = "applied";
                changed = true;
            }
        }
    }
    if (changed)
        saveIndex(stateDir, records);
    const operations = records.map((item, index) => publicRecord(stateDir, item, currentRevision, index === 0));
    return { operations, lastAppliedId: operations.find(item => item.canRestore)?.id };
}
function tokenFor(id, target, revision, restoredRevision, activeRevision, plan) {
    return createHmac("sha256", previewKey)
        .update(JSON.stringify([id, target, revision, restoredRevision, activeRevision, plan]))
        .digest("hex");
}
export function previewSettingsOperation(stateDir, id, target, currentText, currentDocument, active) {
    const records = readIndex(stateDir);
    const record = records.find(item => item.id === id);
    if (!record)
        return undefined;
    const text = readReference(stateDir, target === "before" ? record.before : record.after);
    if (text === undefined)
        return undefined;
    if (sha256(text) !== (target === "before" ? record.beforeRevision : record.revision))
        throw new TypeError("备份内容已变更");
    const document = parseSettingsText(text);
    const normalized = parseSettings(document);
    const revision = sha256(currentText);
    const { liveFields, reloadFields, restartFields } = planSettingsUpdate(active, normalized);
    const plan = { liveFields, reloadFields, restartFields };
    return {
        operation: publicRecord(stateDir, record, revision, records[0] === record),
        target,
        revision,
        document,
        raw: text,
        changes: settingsHistoryChanges(currentDocument, normalized),
        plan,
        hasLaterChanges: revision !== record.revision,
        previewToken: tokenFor(id, target, revision, sha256(text), sha256(JSON.stringify(active)), plan),
    };
}
export function settingsPreviewMatches(preview, token) {
    if (typeof token !== "string" || !hashPattern.test(token))
        return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(preview.previewToken));
}
//# sourceMappingURL=settings-history.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("web/settings-history.ts", { settingsHistoryChanges, reusableSettingsOperation, recordSettingsOperation, applySettingsOperation, listSettingsOperations, previewSettingsOperation, settingsPreviewMatches })
