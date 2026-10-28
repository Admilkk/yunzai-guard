import type { Pm2ApplicationOptions, Pm2DaemonGod, Pm2DaemonContext } from "./types.js";
import type { Pm2LoggingUtility } from "./log-stream-gate-v1.js";
/** 返回规范化的真实路径。 */
export declare function canonical(file: string): string;
/** 判断为非 Proxy 的普通对象。 */
export declare function plain(value: unknown): value is Record<string, unknown>;
/** 判断整数是否在范围内。 */
export declare function integer(value: unknown, minimum: number, maximum: number): value is number;
/** 确认对象指定属性可写。 */
export declare function writable(object: object, keys: string[]): void;
/** 判断随机串是否匹配。 */
export declare function sameNonce(value: unknown, nonce: string): boolean;
/** 查找运行中守护进程的单例，不执行任何 God 模块。 */
export declare function resolveCachedGod(cache: Readonly<Record<string, {
    loaded?: boolean;
    exports: unknown;
} | undefined>>, physicalGodPath: string): Pm2DaemonGod;
/** 取得并校验当前 PM2 daemon 的 God 对象。 */
export declare function currentDaemonGod(options: Pick<Pm2ApplicationOptions, "expectedDaemonPid" | "pm2Root">): Pm2DaemonGod;
/** 解析 PM2 ForkMode 已捕获的同一个 Utility 单例。 */
export declare function resolveCachedLoggingUtility(pm2Root: string): Pm2LoggingUtility | undefined;
/** 返回 daemon 运行上下文。 */
export declare function runtimeContext(pm2Root?: string): Pm2DaemonContext;
