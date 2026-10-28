export interface NodeLaunchContext {
    manifestPath?: string;
    resolutionManifestPath?: string;
    runtimeId: string;
    originPlugin: () => string | undefined;
}
/** 仅移除当前 Guard 安装的预加载器，保留应用自身预加载器和参数。 */
export declare function stripGuardExecArgv(input: readonly string[]): string[];
/** 强制传递受控运行时，不受调用方 execArgv 影响。 */
export declare function monitoredExecArgv(input: readonly string[]): string[];
/** NODE_OPTIONS 使用空白和双引号，不采用 shell 语法；无关参数原样保留。 */
export declare function stripGuardNodeOptions(input: string): string;
/** 在检查前固定启动参数的快照。 */
export declare function snapshotLaunch(operation: string, input: unknown[]): unknown[];
/** 判断是否为可直接继承监控的 Node 子进程启动。 */
export declare function isDirectNodeLaunch(operation: string, args: unknown[]): boolean;
/** 为可识别的 Node 子进程注入运行时预加载与清单。 */
export declare function prepareNodeLaunch(operation: string, input: unknown[], context: NodeLaunchContext): unknown[];
/** 为底层 ChildProcess#spawn 的选项注入运行时预加载。 */
export declare function prepareSpawnOptions(input: object, context?: NodeLaunchContext): Record<PropertyKey, any>;
