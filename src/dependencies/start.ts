import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { hasPm2Environment } from "../pm2/auto.js"
import { nodeReady, prepareNode } from "./node.js"
import { M } from "../shared/messages.js"

/** 普通显式入口保留前台监督，通过 IPC 请求私有 Node 宿主正常退出。 */
export async function usePreparedNode(): Promise<boolean> {
  if (process.platform !== "win32" || nodeReady(process.execPath)) return false
  if (hasPm2Environment() || process.connected) throw new Error(M.dependencies.managerNode)
  const repository = fileURLToPath(new URL("../../", import.meta.url))
  console.info(M.dependencies.preparingNode)
  const executable = await prepareNode(repository)
  const child = spawn(executable, [fileURLToPath(new URL("../launcher.js", import.meta.url))], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_OPTIONS: "" },
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    windowsHide: true,
  })
  let stopping = false
  const stop = () => {
    stopping = true
    if (child.connected) child.send("shutdown", () => {})
  }
  child.on("message", () => {
    if (stopping && child.connected) child.send("shutdown", () => {})
  })
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)))
    })
    process.exitCode = code
  } finally {
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
    if (child.connected) child.disconnect()
  }
  return true
}
