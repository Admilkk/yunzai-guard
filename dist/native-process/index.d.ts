import { ChildProcess } from "node:child_process";
import type { OriginalWindowsChildProbe, NativeIdentityAdapter, NativeIdentityOptions } from "./protocol.js";
export * from "./protocol.js";
export { parseNativeIdentity, parseNativeIdentityJson } from "./validation.js";
/** 仅供宿主使用的适配器；原生操作绝不回退到数字 PID API。 */
export declare function createNativeIdentityAdapter(options?: NativeIdentityOptions): NativeIdentityAdapter;
/** 仅检查宿主是否符合条件，不打开、探测或向子进程发送信号。 */
export declare function assertOriginalWindowsChildProbeRuntime(): void;
/** 受信 spawn 后立即同步调用，必须早于首次 await。 */
export declare function createOriginalWindowsChildProbe(child: ChildProcess): OriginalWindowsChildProbe;
