/** 固定 Windows 实际使用的隐式 shell，环境和归因回调后续变化不再影响启动。 */
export declare function snapshotCommandShell(operation: string, options: Record<PropertyKey, any>, previous?: unknown, previousEnvironment?: unknown): void;
/** 只豁免本次快照记录且 shell 值未变化的系统 cmd，调用者属性不能伪造来源。 */
export declare function isImplicitSystemShell(options: unknown, shell: unknown): boolean;
export declare function isCustomImplicitShell(options: unknown): boolean;
