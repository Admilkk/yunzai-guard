/** 解析维护时段 "HH:MM-HH:MM"，返回当天起止分钟；格式不符返回 undefined。起止相同视为全天。 */
export declare function parseWindow(text: string): {
    start: number;
    end: number;
} | undefined;
/** 判断本地时间是否落在维护时段内，支持跨午夜（如 23:00-02:00）。 */
export declare function inWindow(text: string, date: Date): boolean;
