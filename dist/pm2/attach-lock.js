import net from "node:net";
import { createHash } from "node:crypto";
import { M } from "../shared/messages.js";
/** 内核持有的租约会在接入进程退出时自动释放。 */
export async function acquirePm2AttachLock(parent) {
    const port = 20000 +
        (createHash("sha256").update(`${parent.pid}:${parent.created}`).digest().readUInt32BE(0) %
            10000);
    const deadline = Date.now() + 8000;
    while (true) {
        const server = net.createServer(socket => socket.destroy());
        try {
            await new Promise((resolve, reject) => {
                server.once("error", reject);
                server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
            });
            return () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
        }
        catch (error) {
            server.close();
            if (error.code !== "EADDRINUSE" || Date.now() >= deadline)
                throw new Error(M.pm2.lease);
            await new Promise(resolve => setTimeout(resolve, 40));
        }
    }
}
//# sourceMappingURL=attach-lock.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("pm2/attach-lock.ts", { acquirePm2AttachLock })
