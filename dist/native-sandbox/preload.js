import { isMainThread } from "node:worker_threads";
import { ensureWorkerTransport } from "../runtime/worker-transport.js";
/** 仅用于原生会话传输，Worker 使用运行时 MessagePort，不使用此父进程通道。 */
if (isMainThread) {
    await ensureWorkerTransport();
    const exit = process.exit.bind(process);
    process.once("disconnect", () => exit(0));
    process.send({ type: "preload-hello", pid: process.pid });
}
//# sourceMappingURL=preload.js.map