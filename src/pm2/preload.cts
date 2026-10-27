import fs = require("node:fs")
import path = require("node:path")

/** 仅在真正的 Windows PM2 daemon 中安装兼容层；NODE_OPTIONS 也会传入 CLI 与应用，其他进程不做任何操作。 */
function activatePm2Preload(): void {
  if (process.platform !== "win32") return
  const entryName = path.basename(process.argv[1] ?? "")
  const daemon = entryName === "Daemon.js"
  if (!daemon && entryName !== "pm2") return
  let entryPath: string
  let metadata: { name?: unknown; version?: unknown }
  try {
    entryPath = fs.realpathSync.native(process.argv[1]!)
    if (path.basename(entryPath).toLowerCase() !== (daemon ? "daemon.js" : "pm2")) return
    if (path.basename(path.dirname(entryPath)) !== (daemon ? "lib" : "bin")) return
    metadata = JSON.parse(
      fs.readFileSync(path.join(path.dirname(entryPath), "../package.json"), "utf8"),
    )
  } catch {
    return // 无关应用也可能名为 Daemon.js。
  }
  if (!metadata || typeof metadata !== "object" || metadata.name !== "pm2") return
  const { isSupportedPm2Version } = require("./versions.js") as typeof import("./versions.js")
  const { M } = require("../shared/messages.js") as typeof import("../shared/messages.js")
  if (!isSupportedPm2Version(metadata.version))
    throw new Error(M.pm2.preloadVersion(String(metadata.version)))
  // 在不支持的 CLI 尝试启动无法应答的守护进程前报错。
  if (!daemon) return
  const library = path.dirname(entryPath)
  const { installPm2Compatibility } = require("./compat.js") as typeof import("./compat.js")
  const god = require(path.join(library, "God.js")) as import("./compat.js").Pm2God
  installPm2Compatibility(god, {
    launcherPath: path.join(__dirname, "../launcher.js"),
    report: event => {
      // 诊断不包含应用环境变量、argv 或凭据。
      console.error(`${M.pm2.preloadTag} ${JSON.stringify(event)}`)
    },
  })
  console.error(M.pm2.preloadActive(String(metadata.version)))
}
activatePm2Preload()
