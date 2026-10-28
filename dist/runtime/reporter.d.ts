import type { AuditSender } from "../audit/sender.js";
import type { AuditSealFrame } from "../audit/protocol.js";
import type { GuardEvent, GuardSettings } from "../shared/types.js";
import type { RuntimeIdentity, WorkerAuditCloseOptions, WorkerAuditCoverage } from "./worker-monitor.js";
export interface Lifecycle {
    prepare(options: WorkerAuditCloseOptions): void;
    coverage(): WorkerAuditCoverage["nestedCoverage"];
    dispose(): void;
}
/** 在事件中附加运行时身份。 */
export declare function attach(event: GuardEvent, identity: RuntimeIdentity): GuardEvent;
/** 报告运行时降级；非 audit 策略下直接退出进程。 */
export declare function reportFailure(settings: GuardSettings, identity: RuntimeIdentity, reason: string): import("../config/policy.js").PolicyDecision;
/** 首次读取时上报一次传输摘要；传输不完整时把已结清的嵌套覆盖降为 incomplete。 */
export declare function trackCoverage(emit: (event: GuardEvent) => void, target: string, nestedCoverage: Lifecycle["coverage"]): () => "settled" | "incomplete" | "unknown";
/** 为子运行时创建覆盖上报函数。 */
export declare function createReporter(sender: AuditSender, identity: RuntimeIdentity, nestedCoverage: Lifecycle["coverage"]): () => "settled" | "incomplete" | "unknown";
/** 把无效回复数量计入密封帧。 */
export declare function addInvalidReplies(seal: AuditSealFrame, invalidReplies: number): AuditSealFrame;
