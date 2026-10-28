/** 持久化的重启预算与熔断状态。 */
export interface RecoveryState {
    version: 1;
    failures: Array<{
        time: number;
        reason: string;
    }>;
    tripped: boolean;
    reason?: string;
}
/** 损坏的计数不能放行无限重启：无法解析时视为已熔断，保留控制端点供恢复。 */
export declare function readRecoveryState(file: string): RecoveryState;
/** 原子写入熔断与恢复状态。 */
export declare function saveRecoveryState(file: string, state: RecoveryState): void;
