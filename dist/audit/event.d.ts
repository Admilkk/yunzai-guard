type Row = Record<string, unknown>;
/** 保留受限证据标签，省略自由格式参数、SDK 错误及凭据。 */
export declare function sanitizeAuditEvent(value: unknown, redact: (text: string) => string): Row | undefined;
export {};
