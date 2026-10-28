import type { Writable } from "node:stream";
import { type TransportCounters } from "./diagnostics.js";
/** 生命周期回调保留原进程句柄的所有权。 */
export interface DisposeOptions {
    stop(): void;
    hasExited(): boolean;
    kill(): void;
    exited: Promise<void>;
    cleanup: Promise<void>;
    timeout: number;
}
/** 回调成功仅证明原生 stdin 写入完成，不证明审计追加完成。 */
export declare function writeControl(stream: Pick<Writable, "writable" | "destroyed" | "writableLength" | "write"> | null, connected: boolean, message: unknown, counters: TransportCounters["control"], callback?: (error: Error | null) => void): boolean;
/** 用户输出流无法继续接收时，仍持续排空原生 stdout。 */
export declare function forwardOutput(stream: Pick<Writable, "writable" | "destroyed" | "writableLength" | "write">, bytes: Buffer, counters: TransportCounters["output"]): boolean;
/** stop 写入失败也必须清理原 ChildProcess 句柄。 */
export declare function disposeProcess(options: DisposeOptions): Promise<void>;
