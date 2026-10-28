import type { ChildProcess } from "node:child_process";
type Output = NodeJS.WritableStream;
/** 删除超过保留天数没有再写入的 host.log 及其轮转文件；maxDays 为 0 时不处理。 */
export declare function pruneHostLog(directory: string, maxDays: number, now?: number): number;
/** 把宿主控制台输出同时写入日志文件。 */
export declare function installHostLog(directory: string, { maxBytes, stdout, stderr, }?: {
    maxBytes?: number;
    stdout?: Output;
    stderr?: Output;
}): () => void;
/** 把业务进程的标准输出转发到宿主输出。 */
export declare function pipeHostOutput(child: Pick<ChildProcess, "stdout" | "stderr">, stdout?: Output, stderr?: Output): (timeout: number) => Promise<void>;
export {};
