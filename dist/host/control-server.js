import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import { M } from "../shared/messages.js";
export const controlCommands = [
    "status",
    "restart",
    "stop",
    "resume",
    "invoke-bot-restart",
    "check-update",
    "update",
    "force-update",
    "rollback",
    "input",
];
const maxConnections = 32;
// input 携带控制台输入，转印进程按 JSON 编码后的字节数分段，见 control.ts 的 splitInput。
export const maxRequestBytes = 16384;
const idleTimeoutMs = 2000;
/**
 * 本机 CLI 控制端点：单行 JSON 请求，常量时间比较令牌。
 * 任何格式、认证或命令错误都直接断开，不回传原因。
 */
export function createControlServer({ token, handle, after }) {
    const sockets = new Set();
    const expected = Buffer.from(token);
    return net.createServer(socket => {
        if (sockets.size >= maxConnections) {
            socket.destroy();
            return;
        }
        sockets.add(socket);
        let text = "";
        let answered = false;
        socket.setTimeout(idleTimeoutMs, () => socket.destroy());
        socket.on("error", () => { });
        socket.once("close", () => sockets.delete(socket));
        socket.on("data", (chunk) => {
            if (answered)
                return;
            text += chunk.toString("utf8");
            if (Buffer.byteLength(text) > maxRequestBytes) {
                socket.destroy();
                return;
            }
            if (!text.includes("\n"))
                return;
            answered = true;
            try {
                const raw = JSON.parse(text.split("\n")[0]);
                if (!raw || typeof raw !== "object" || Array.isArray(raw))
                    throw new Error(M.host.commandInvalid);
                const message = raw;
                if (typeof message.token !== "string")
                    throw new Error(M.host.credential);
                const received = Buffer.from(message.token);
                if (received.length !== expected.length || !timingSafeEqual(received, expected))
                    throw new Error(M.host.credential);
                const command = message.command;
                if (typeof command !== "string" || !controlCommands.includes(command))
                    throw new Error(M.host.commandUnknown);
                socket.end(`${JSON.stringify(handle(command, message))}\n`);
                after?.(command);
            }
            catch {
                socket.destroy();
            }
        });
    });
}
//# sourceMappingURL=control-server.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("host/control-server.ts", { controlCommands, maxRequestBytes, createControlServer })
