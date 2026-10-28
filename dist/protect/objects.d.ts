import type { EmitEvent } from "../shared/types.js";
import type { HookWatch } from "../monitor/watch.js";
/** 自保护不经过可配置业务规则，也不以日志成功作为拒绝条件。 */
export declare function refuse(operation: string, target: string): never;
/** 仅固定 Guard 自有函数槽，不冻结整个 Node 模块或业务对象。 */
export declare function seal(object: object, key: PropertyKey, value: unknown, label?: string, allowCopy?: boolean): void;
/** 构建时为自有模块追加登记；稍后导入的模块也立即固定其函数。 */
export declare function registerModule(name: string, exports: Record<string, unknown>): void;
/** 安装 Guard 自有对象的保护，并把篡改尝试上报为自保护事件。 */
export declare function protectObjects(deliver: EmitEvent, context?: () => string | undefined, observer?: HookWatch): void;
/** 配置是纯数据；固定快照，避免通过全局上下文改写监控策略。 */
export declare function freezeData<T>(value: T): T;
