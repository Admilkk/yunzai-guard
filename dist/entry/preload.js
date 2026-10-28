import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerCurrentPm2Application, hasPm2Environment } from "../pm2/auto.js";
import { loadSettings } from "../config/index.js";
import { root, stateDir } from "../shared/identity.js";
import { usePreparedNode } from "../dependencies/start.js";
import { M } from "../shared/messages.js";
// 必须先于 app.js 加载，当前进程作为宿主。
if (path.basename(process.argv[1] ?? "") === "app.js" || hasPm2Environment()) {
    try {
        if (await usePreparedNode())
            process.exit(process.exitCode ?? 0);
        const settings = loadSettings(stateDir);
        await registerCurrentPm2Application({
            root,
            launcherPath: fileURLToPath(new URL("../launcher.js", import.meta.url)),
            shutdownTimeout: settings.shutdownTimeout,
            startupTimeout: settings.startupTimeout,
            requestRestart: false,
        });
    }
    catch (error) {
        console.error(M.entry.pm2EarlyRegisterFailed(error.message));
        process.exit(78);
    }
    await import("../host/supervisor.js");
    await new Promise(() => { });
}
//# sourceMappingURL=preload.js.map