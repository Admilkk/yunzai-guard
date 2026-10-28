import { type DatabaseSync } from "node:sqlite";
export declare const auditDatabaseName = "events.sqlite";
export declare const auditApplicationId = 1497846340;
export declare const auditSchemaVersion = 1;
/** 返回状态目录下的审计数据库路径。 */
export declare function auditDatabasePath(stateDir: string): string;
/** 确认数据库及其目录是普通文件和真实目录。 */
export declare function assertAuditFiles(file: string): void;
/** 打开审计数据库并核对打开前后的文件身份。 */
export declare function openAuditDatabase(file: string, readOnly?: boolean): DatabaseSync;
/** 按需建表并校验数据库版本与应用标识。 */
export declare function initializeAuditDatabase(database: DatabaseSync): void;
