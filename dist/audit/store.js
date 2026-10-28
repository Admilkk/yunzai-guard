import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { assertAuditFiles, initializeAuditDatabase, openAuditDatabase } from "./database.js";
import { storedAuditRecord } from "./record.js";
import { copyAuditData } from "./protocol.js";
import { M } from "../shared/messages.js";
const insertSql = `INSERT OR IGNORE INTO events
  (origin,sequence,host_pid,time,type,plugin,kind,operation,target,action,rule_id,blocked,search,payload,bytes,loss_reported)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
/** 校验保留容量与倍数的取值范围。 */
function limits(maxBytes, maxFiles) {
    if (!Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        !Number.isSafeInteger(maxFiles) ||
        maxFiles < 1 ||
        maxFiles > 100 ||
        !Number.isSafeInteger(maxBytes * maxFiles))
        throw new TypeError(M.audit.retentionLimits);
}
export class SqliteAuditSink {
    #options;
    #database;
    #insert;
    #identity;
    #sequence = 0;
    #available = true;
    #unknownState = false;
    #closed = false;
    #written = 0;
    #rejected = 0;
    #unknown = 0;
    #records = 0;
    #bytes = 0;
    #evictedRecords = 0;
    #evictedBytes = 0;
    #error;
    #sync = "FULL";
    /** 打开 SQLite 审计存储并准备语句。 */
    constructor(options) {
        limits(options.maxBytes, options.maxFiles);
        if (!path.isAbsolute(options.filePath))
            throw new TypeError(M.audit.dbPathAbsolute);
        this.#options = { ...options };
        fs.mkdirSync(path.dirname(options.filePath), { recursive: true, mode: 0o700 });
        assertAuditFiles(options.filePath);
        if (!fs.existsSync(options.filePath)) {
            const handle = fs.openSync(options.filePath, fs.constants.O_CREAT |
                fs.constants.O_EXCL |
                fs.constants.O_WRONLY |
                (fs.constants.O_NOFOLLOW ?? 0), 0o600);
            fs.closeSync(handle);
        }
        const database = openAuditDatabase(options.filePath);
        try {
            initializeAuditDatabase(database);
            database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=4194304");
            this.#database = database;
            const identity = fs.statSync(options.filePath);
            this.#identity = { dev: identity.dev, ino: identity.ino };
            this.#insert = database.prepare(insertSql);
            this.#importLegacy();
            const retained = this.#retained();
            this.#records = retained.records;
            this.#bytes = retained.bytes;
            this.#sequence = Math.max(this.#metaNumber("lastSequence"), Number(database.prepare("SELECT coalesce(max(sequence),0) AS value FROM events").get().value));
            this.#evictedRecords = this.#metaNumber("evictedRecords");
            this.#evictedBytes = this.#metaNumber("evictedBytes");
            this.updateLimits(options);
        }
        catch (error) {
            database.close();
            throw error;
        }
    }
    /** 读取数值型元数据。 */
    #metaNumber(key) {
        const value = Number(this.#database.prepare("SELECT value FROM audit_meta WHERE key=?").get(key)?.value ?? 0);
        return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    }
    /** 写入元数据。 */
    #meta(key, value) {
        this.#database
            .prepare("INSERT INTO audit_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .run(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    /** 统计当前保留的事件数与字节数。 */
    #retained() {
        const row = this.#database
            .prepare("SELECT count(*) AS records,coalesce(sum(bytes),0) AS bytes FROM events")
            .get();
        return { records: Number(row.records), bytes: Number(row.bytes) };
    }
    /** 确认数据库文件身份未被替换。 */
    #checkFiles() {
        assertAuditFiles(this.#options.filePath);
        const identity = fs.statSync(this.#options.filePath);
        if (identity.dev !== this.#identity.dev || identity.ino !== this.#identity.ino)
            throw new Error(M.audit.dbIdentityChanged);
    }
    /** 插入一条记录，重复来源返回 false。 */
    #add(record, origin = null) {
        const result = this.#insert.run(origin, record.sequence, record.hostPid, record.time, record.type, record.plugin, record.kind, record.operation, record.target, record.action, record.ruleId, record.blocked, record.search, record.payload, record.bytes, record.lossReported);
        return Number(result.changes) === 1;
    }
    /** 一次性、有界地导入旧 JSONL 日志。 */
    #importLegacy() {
        if (this.#database.prepare("SELECT 1 FROM audit_meta WHERE key='legacyImport'").get())
            return;
        const directory = path.dirname(this.#options.filePath);
        const report = {
            imported: 0,
            duplicates: 0,
            bytesRead: 0,
            invalidLines: 0,
            filesRead: 0,
            filesSkipped: 0,
            truncated: false,
            errors: [],
        };
        const records = [];
        let examined = 0;
        for (let rotation = 0; rotation < 100; rotation++) {
            const name = rotation ? `events.jsonl.${rotation}` : "events.jsonl";
            const file = path.join(directory, name);
            let handle;
            try {
                const info = fs.lstatSync(file);
                if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
                    report.filesSkipped++;
                    continue;
                }
                if (report.bytesRead >= 4 * 1024 * 1024 || examined >= 20000) {
                    report.truncated = true;
                    report.filesSkipped++;
                    continue;
                }
                handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
                const opened = fs.fstatSync(handle);
                if (!opened.isFile() ||
                    opened.nlink !== 1 ||
                    opened.ino !== info.ino ||
                    opened.dev !== info.dev)
                    throw new Error(M.audit.legacyIdentityChanged);
                const size = Math.min(opened.size, 4 * 1024 * 1024 - report.bytesRead);
                const begin = opened.size - size;
                const bytes = Buffer.alloc(size);
                const length = fs.readSync(handle, bytes, 0, size, begin);
                report.bytesRead += length;
                report.filesRead++;
                if (begin > 0)
                    report.truncated = true;
                const lines = bytes.subarray(0, length).toString("utf8").split("\n");
                if (begin > 0)
                    lines.shift();
                for (let index = lines.length - 1; index >= 0; index--) {
                    const line = lines[index].trim();
                    if (!line)
                        continue;
                    if (examined++ >= 20000) {
                        report.truncated = true;
                        break;
                    }
                    try {
                        if (Buffer.byteLength(line) > 128 * 1024)
                            throw new Error(M.audit.legacyLineTooLarge);
                        const parsed = JSON.parse(line);
                        const value = storedAuditRecord(parsed);
                        const identity = Number.isSafeInteger(parsed.hostPid) && Number.isSafeInteger(parsed.sequence)
                            ? `${parsed.hostPid}:${parsed.sequence}:${value.time}`
                            : line;
                        records.push({
                            value,
                            origin: "legacy:" + createHash("sha256").update(identity).digest("hex"),
                        });
                    }
                    catch {
                        report.invalidLines++;
                    }
                }
            }
            catch (error) {
                if (error.code !== "ENOENT") {
                    report.filesSkipped++;
                    if (report.errors.length < 8)
                        report.errors.push(`${name}: ${error.code ?? "unreadable"}`);
                }
            }
            finally {
                if (handle !== undefined)
                    fs.closeSync(handle);
            }
        }
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            for (const record of records.reverse()) {
                if (this.#add(record.value, record.origin))
                    report.imported++;
                else
                    report.duplicates++;
            }
            this.#meta("legacyImport", report);
            this.#database.exec("COMMIT");
        }
        catch (error) {
            try {
                this.#database.exec("ROLLBACK");
            }
            catch { }
            throw error;
        }
    }
    /** 淘汰最旧事件直到不超过保留预算。 */
    #prune(bytes, budget) {
        let removed = 0;
        let count = 0;
        while (bytes - removed > budget) {
            const rows = this.#database.prepare("SELECT id,bytes FROM events ORDER BY id LIMIT 256").all();
            if (!rows.length)
                break;
            let cutoff = 0;
            for (const row of rows) {
                cutoff = Number(row.id);
                removed += Number(row.bytes);
                count++;
                if (bytes - removed <= budget)
                    break;
            }
            this.#database.prepare("DELETE FROM events WHERE id<=?").run(cutoff);
        }
        if (count) {
            this.#meta("evictedRecords", this.#evictedRecords + count);
            this.#meta("evictedBytes", this.#evictedBytes + removed);
        }
        return { records: count, bytes: removed };
    }
    /**
     * 设置本批写入的落盘强度：普通记录在 WAL 下用 NORMAL，进程崩溃不丢、仅断电可能丢最后几批；
     * 含拦截或重启的批次以及 full 模式始终用 FULL。
     */
    #durability(critical) {
        const mode = critical || this.#options.durability !== "adaptive" ? "FULL" : "NORMAL";
        if (mode === this.#sync)
            return;
        this.#database.exec(`PRAGMA synchronous=${mode}`);
        this.#sync = mode;
    }
    /** 删除早于保留天数的事件，返回删除条数；days 为 0 时不处理。 */
    pruneByAge(days, now = Date.now()) {
        if (!Number.isFinite(days) || days <= 0)
            return 0;
        if (this.#closed)
            throw new Error(M.audit.dbClosed);
        this.#checkFiles();
        const cutoff = now - days * 86400000;
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            const row = this.#database
                .prepare("SELECT count(*) AS records,coalesce(sum(bytes),0) AS bytes FROM events WHERE time<?")
                .get(cutoff);
            const records = Number(row.records);
            if (records)
                this.#database.prepare("DELETE FROM events WHERE time<?").run(cutoff);
            this.#database.exec("COMMIT");
            this.#records -= records;
            this.#bytes -= Number(row.bytes);
            return records;
        }
        catch (error) {
            try {
                this.#database.exec("ROLLBACK");
            }
            catch { }
            throw error;
        }
    }
    /** 更新保留预算并立即淘汰超出部分。 */
    updateLimits(options) {
        limits(options.maxBytes, options.maxFiles);
        if (this.#closed)
            throw new Error(M.audit.dbClosed);
        this.#checkFiles();
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            const removed = this.#prune(this.#bytes, options.maxBytes * options.maxFiles);
            this.#meta("retentionBytes", options.maxBytes * options.maxFiles);
            this.#database.exec("COMMIT");
            this.#bytes -= removed.bytes;
            this.#records -= removed.records;
            this.#evictedBytes += removed.bytes;
            this.#evictedRecords += removed.records;
            this.#options.maxBytes = options.maxBytes;
            this.#options.maxFiles = options.maxFiles;
        }
        catch (error) {
            try {
                this.#database.exec("ROLLBACK");
            }
            catch { }
            throw error;
        }
    }
    /** 批量写入事件，逐条返回回执。 */
    appendBatch(frames) {
        if (frames.length > 256)
            throw new TypeError(M.audit.batchLimit);
        const receipts = new Array(frames.length);
        const prepared = [];
        for (let index = 0; index < frames.length; index++) {
            if (this.#closed || this.#unknownState) {
                receipts[index] = { result: "rejected", reason: "sink-error" };
                this.#rejected++;
                continue;
            }
            try {
                const frame = frames[index];
                const sequence = this.#sequence + 1;
                if (!Number.isSafeInteger(sequence))
                    throw new Error(M.audit.sequenceExhausted);
                const details = copyAuditData(frame.details ?? {});
                if (details === null || typeof details !== "object" || Array.isArray(details))
                    throw new TypeError(M.audit.details);
                const value = storedAuditRecord({
                    ...details,
                    sequence,
                    hostPid: this.#options.hostPid ?? process.pid,
                    time: frame.time ?? this.#options.wallNow?.() ?? Date.now(),
                    type: frame.type,
                });
                if (value.bytes > this.#options.maxBytes) {
                    receipts[index] = { result: "rejected", reason: "oversize" };
                    this.#rejected++;
                    continue;
                }
                this.#sequence = sequence;
                prepared.push({ index, value });
            }
            catch {
                receipts[index] = { result: "rejected", reason: "serialization" };
                this.#rejected++;
            }
        }
        if (!prepared.length)
            return receipts;
        let begun = false;
        try {
            this.#checkFiles();
            this.#durability(prepared.some(item => item.value.action === "deny" || item.value.action === "restart"));
            this.#database.exec("BEGIN IMMEDIATE");
            begun = true;
            let bytes = 0;
            for (const item of prepared) {
                if (!this.#add(item.value))
                    throw new Error(M.audit.notInserted);
                bytes += item.value.bytes;
            }
            const removed = this.#prune(this.#bytes + bytes, this.#options.maxBytes * this.#options.maxFiles);
            this.#meta("lastSequence", this.#sequence);
            this.#database.exec("COMMIT");
            begun = false;
            this.#bytes += bytes - removed.bytes;
            this.#records += prepared.length - removed.records;
            this.#evictedBytes += removed.bytes;
            this.#evictedRecords += removed.records;
            this.#available = true;
            this.#error = undefined;
            for (const item of prepared)
                receipts[item.index] = {
                    result: "written",
                    sequence: item.value.sequence,
                    bytes: item.value.bytes,
                };
            this.#written += prepared.length;
        }
        catch (error) {
            let rolledBack = !begun;
            if (begun)
                try {
                    this.#database.exec("ROLLBACK");
                    rolledBack = true;
                }
                catch { }
            this.#available = false;
            this.#unknownState = !rolledBack;
            this.#error = error.message;
            for (const item of prepared) {
                receipts[item.index] = rolledBack
                    ? { result: "rejected", reason: "sink-error", sequence: item.value.sequence }
                    : { result: "unknown", reason: "partial-write", sequence: item.value.sequence };
                if (rolledBack)
                    this.#rejected++;
                else
                    this.#unknown++;
            }
        }
        return receipts;
    }
    /** 写入单条事件。 */
    record(type, details = {}, time) {
        return this.appendBatch([{ type, details, time }])[0];
    }
    /** 返回存储统计快照。 */
    stats() {
        return {
            lastAllocatedSequence: this.#sequence,
            available: this.#available && !this.#closed,
            framingUnknown: this.#unknownState,
            written: this.#written,
            rejected: this.#rejected,
            unknown: this.#unknown,
            filesEvicted: 0,
            bytesEvicted: this.#evictedBytes,
            rotationCoverageUnknown: false,
            evidence: "sqlite-transaction-committed",
            storage: "sqlite",
            path: this.#options.filePath,
            retainedRecords: this.#records,
            retainedBytes: this.#bytes,
            evictedRecords: this.#evictedRecords,
            retentionBytes: this.#options.maxBytes * this.#options.maxFiles,
            ...(this.#error ? { error: this.#error } : {}),
        };
    }
    /** 关闭数据库，可重复调用。 */
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        try {
            this.#database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        }
        finally {
            this.#database.close();
        }
    }
}
//# sourceMappingURL=store.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("audit/store.ts", { SqliteAuditSink })
