import { fileURLToPath } from "node:url"
import { registerCurrentPm2Application } from "../pm2/auto.js"
import { loadSettings } from "../config/index.js"
import { root, stateDir } from "../shared/identity.js"
import { usePreparedNode } from "../dependencies/start.js"
import { M } from "../shared/messages.js"

try {
  if (await usePreparedNode()) process.exit(process.exitCode ?? 0)
  const settings = loadSettings(stateDir)
  await registerCurrentPm2Application({
    root,
    launcherPath: fileURLToPath(new URL("../launcher.js", import.meta.url)),
    shutdownTimeout: settings.shutdownTimeout,
    startupTimeout: settings.startupTimeout,
    requestRestart: false,
  })
} catch (error) {
  console.error(M.entry.pm2RegisterFailed((error as Error).message))
  process.exit(78)
}
await import("../host/supervisor.js")
