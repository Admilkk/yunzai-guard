import { request } from "../host/control.js"
import { M } from "../shared/messages.js"

const command = process.argv[2] ?? "status"
if (command === "log") {
  // 在终端实时跟随宿主与业务进程的控制台输出（data/yunzai-guard/host.log）。
  const { logCommand } = await import("./log.js")
  await logCommand(process.argv.slice(3))
} else if (command === "doctor") {
  try {
    const { prepareDependencies } = await import("../dependencies/check.js")
    const { loadSettings } = await import("../config/index.js")
    const { stateDir } = await import("../shared/identity.js")
    console.log(JSON.stringify(await prepareDependencies(loadSettings(stateDir)), null, 2))
  } catch (error) {
    console.error(M.cli.prepareFailed((error as Error).message))
    process.exitCode = 1
  }
} else if (command === "sandbox" || command === "native") {
  try {
    const run =
      command === "native"
        ? (await import("./native.js")).nativeCommand
        : (await import("./sandbox.js")).sandboxCommand
    console.log(JSON.stringify(await run(process.argv.slice(3), process.cwd()), null, 2))
  } catch (error) {
    console.error(M.cli.failed((error as Error).message))
    process.exitCode = 1
  }
} else {
  if (!["status", "restart", "stop", "resume"].includes(command)) {
    console.error(M.cli.usage)
    process.exit(2)
  }
  try {
    console.log(JSON.stringify(await request(command), null, 2))
  } catch (error) {
    console.error(M.cli.failed((error as Error).message))
    process.exitCode = 1
  }
}
