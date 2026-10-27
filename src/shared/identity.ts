import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

export const contextKey = Symbol.for("yunzai.guard.context.v1")
// 启动器已规范化 cwd；AppContainer 内可能无权查询其祖先目录。
const sandboxWorker =
  process.platform === "win32" &&
  process.env.YUNZAI_GUARD_SANDBOX === "appcontainer" &&
  Boolean(process.env.YUNZAI_GUARD_PIPE) &&
  process.execArgv.includes(new URL("../worker-preload.js", import.meta.url).href)
export const root = sandboxWorker
  ? path.resolve(process.cwd())
  : fs.realpathSync.native(process.cwd())
export const stateDir = path.join(root, "data", "yunzai-guard")
const identity = process.platform === "win32" ? root.toLowerCase() : root
export const projectId = createHash("sha256").update(identity).digest("hex").slice(0, 16)
