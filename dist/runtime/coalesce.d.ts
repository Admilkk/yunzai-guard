import type { GuardEvent } from "../shared/types.js";
export interface CoalesceOptions {
    /** 合并窗口；0 表示不合并。 */
    windowMs: () => number;
    /** 同时跟踪的不同事件上限，超过后不再合并新事件，避免内存随目标数增长。 */
    maxKeys: number;
    /** 交给审计队列，返回是否被接收。 */
    forward: (event: GuardEvent, critical: boolean) => boolean;
}
/**
 * 业务进程侧的事件合并：窗口内完全相同的普通记录只发第一条，其余计数后以一条
 * “重复 N 次”汇总补发；队列已满被拒的记录按插件与类型累计，之后补一条溢出说明。
 * 拒绝、重启等关键事件始终逐条发送。
 */
export declare class EventCoalescer {
    #private;
    /** 创建合并器。 */
    constructor(options: CoalesceOptions);
    /** 提交一条事件。 */
    offer(event: GuardEvent, critical: boolean): void;
    /** 补发重复计数与溢出说明，清理已安静的条目。 */
    flush(): void;
    /** 停止计时并立即结算，供业务进程退出前调用。 */
    close(): void;
}
