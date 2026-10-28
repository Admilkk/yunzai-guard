import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { stateDir } from "../shared/identity.js";
import { M } from "../shared/messages.js";
/** 管理命令不读取待生效的配置，配置写坏时仍可停止或恢复现有宿主。 */
export function request(command) {
    const { token, port } = JSON.parse(fs.readFileSync(path.join(stateDir, "control.json"), "utf8"));
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        let data = "";
        socket.setTimeout(5000, () => socket.destroy(new Error(M.host.controlTimeout)));
        socket.on("error", reject);
        socket.on("connect", () => socket.write(`${JSON.stringify({ token, command })}\n`));
        socket.on("data", chunk => {
            data += chunk;
            if (Buffer.byteLength(data) > 1024 * 1024)
                return socket.destroy(new Error(M.host.controlTooLarge));
            if (data.includes("\n")) {
                socket.end();
                try {
                    resolve(JSON.parse(data.split("\n")[0]));
                }
                catch (error) {
                    reject(error);
                }
            }
        });
        socket.on("end", () => {
            if (!data.includes("\n"))
                reject(new Error(M.host.controlIncomplete));
        });
    });
}
//# sourceMappingURL=control.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("host/control.ts", { request })
