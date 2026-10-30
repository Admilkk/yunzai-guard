import fs from "node:fs";
import path from "node:path";
import sqlite from "node:sqlite";
import { M } from "../shared/messages.js";
import { isOrdinaryFile } from "../shared/files.js";
export const auditDatabaseName = "events.sqlite";
export const auditApplicationId = 0x59475244;
export const auditSchemaVersion = 1;
/** 返回状态目录下的审计数据库路径。 */
export function auditDatabasePath(stateDir) {
    return path.join(stateDir, auditDatabaseName);
}
/** 确认数据库及其目录是普通文件和真实目录。 */
export function assertAuditFiles(file) {
    const directory = fs.lstatSync(path.dirname(file));
    if (!directory.isDirectory() || directory.isSymbolicLink())
        throw new Error(M.audit.dbDirectory);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        try {
            const info = fs.lstatSync(file + suffix);
            if (!isOrdinaryFile(info))
                throw new Error(M.audit.dbFiles);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
}
/** 打开审计数据库并核对打开前后的文件身份。 */
export function openAuditDatabase(file, readOnly = false) {
    assertAuditFiles(file);
    const before = fs.statSync(file);
    const database = new sqlite.DatabaseSync(file, { readOnly, allowExtension: false });
    try {
        const after = fs.statSync(file);
        if (before.dev !== after.dev || before.ino !== after.ino)
            throw new Error(M.audit.dbIdentityOpening);
        database.exec("PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON");
        if (readOnly) {
            database.exec("PRAGMA query_only=ON");
            const version = Number(database.prepare("PRAGMA user_version").get().user_version);
            const application = Number(database.prepare("PRAGMA application_id").get().application_id);
            if (version !== auditSchemaVersion || application !== auditApplicationId)
                throw new Error(M.audit.dbSchema);
        }
        return database;
    }
    catch (error) {
        database.close();
        throw error;
    }
}
/** 按需建表并校验数据库版本与应用标识。 */
export function initializeAuditDatabase(database) {
    const version = Number(database.prepare("PRAGMA user_version").get().user_version);
    const application = Number(database.prepare("PRAGMA application_id").get().application_id);
    if (version === auditSchemaVersion && application === auditApplicationId)
        return;
    const existing = Number(database
        .prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
        .get().count);
    if (version !== 0 || application !== 0 || existing)
        throw new Error(M.audit.dbForeign);
    database.exec("PRAGMA auto_vacuum=INCREMENTAL");
    database.exec("BEGIN IMMEDIATE");
    try {
        database.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      origin TEXT UNIQUE,
      sequence INTEGER NOT NULL,
      host_pid INTEGER NOT NULL,
      time REAL NOT NULL,
      type TEXT NOT NULL,
      plugin TEXT NOT NULL,
      kind TEXT NOT NULL,
      operation TEXT NOT NULL,
      target TEXT NOT NULL,
      action TEXT NOT NULL,
      rule_id TEXT,
      blocked INTEGER,
      search TEXT NOT NULL,
      payload TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      loss_reported INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX events_time ON events(time DESC,id DESC);
    CREATE INDEX events_plugin_time ON events(plugin,time DESC,id DESC);
    CREATE INDEX events_kind_time ON events(kind,time DESC,id DESC);
    CREATE INDEX events_action_time ON events(action,time DESC,id DESC);
    CREATE TABLE audit_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
    PRAGMA application_id=${auditApplicationId};
    PRAGMA user_version=${auditSchemaVersion};
  `);
        database.exec("COMMIT");
    }
    catch (error) {
        try {
            database.exec("ROLLBACK");
        }
        catch { }
        throw error;
    }
}
//# sourceMappingURL=database.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("audit/database.ts", { auditDatabaseName, auditApplicationId, auditSchemaVersion, auditDatabasePath, assertAuditFiles, openAuditDatabase, initializeAuditDatabase })
