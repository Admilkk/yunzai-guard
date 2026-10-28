import type { EmitEvent } from "../shared/types.js";
interface SqliteGuardOptions {
    roots: string[];
    readRoots?: string[];
    deny(operation: string, target: string): never;
    seal(object: object, key: PropertyKey, value: unknown, label: string): void;
    emit?: EmitEvent;
}
/** 包装 node:sqlite，禁止打开受保护数据库并记录缺少授权器的覆盖不足。 */
export declare function installSqliteGuard(options: SqliteGuardOptions): void;
export {};
