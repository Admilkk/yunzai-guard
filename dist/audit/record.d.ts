export interface StoredAuditRecord {
    sequence: number;
    hostPid: number;
    time: number;
    type: string;
    plugin: string;
    kind: string;
    operation: string;
    target: string;
    action: string;
    ruleId: string | null;
    blocked: number | null;
    search: string;
    payload: string;
    bytes: number;
    lossReported: number;
}
/** 把输入转为可落盘的脱敏审计记录。 */
export declare function storedAuditRecord(input: unknown): StoredAuditRecord;
