type Line = string | false | null | undefined;
/** 组合一条通知。 */
export declare function notice(title: string, ...lines: Line[]): string;
/** “字段：值”行；值为空时省略整行。 */
export declare function field(label: string, value: unknown): string | undefined;
/** 列出前三项，超出时注明总数；total 用于条目已被截断的情况。 */
export declare function listed(items: string[], total?: number): string;
export {};
