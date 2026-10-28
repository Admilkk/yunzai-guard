// 在一个已安装依赖的 Yunzai 目录里做接管冒烟：安装当前构建与探针插件，普通启动，检查状态后停止。
// 用法：node scripts/smoke-yunzai.mjs <Yunzai 目录> [--pm2]；CI 用于在没有真机的平台（macOS）
// 以及不便在开发机上运行的 PM2 版本（Windows 的 PM2 命名管道全局唯一）上验证。
import fs from "node:fs"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const root = path.resolve(process.argv[2] ?? "")
const usePm2 = process.argv.includes("--pm2")

/** 调用 PM2 命令行；Windows 上 pm2 是 .cmd，需要经由 shell。 */
function pm2(...args) {
  const result = spawnSync("pm2", args, {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  })
  return result
}
if (!fs.existsSync(path.join(root, "app.js"))) throw new Error(`不是 Yunzai 目录：${root}`)
const plugin = path.join(root, "plugins", "yunzai-guard")
const stateDir = path.join(root, "data", "yunzai-guard")
const log = path.join(stateDir, "host.log")
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 等待条件成立，超时报错。 */
async function until(check, timeout, label) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(1000)
  }
  throw new Error(`等待超时：${label}`)
}

/** 读取 Guard 状态；未运行时返回 undefined。 */
function status() {
  const result = spawnSync(process.execPath, [path.join(plugin, "dist", "cli.js"), "status"], {
    cwd: root,
    encoding: "utf8",
  })
  try {
    return JSON.parse(result.stdout)
  } catch {
    return undefined
  }
}

fs.rmSync(plugin, { recursive: true, force: true })
fs.mkdirSync(plugin, { recursive: true })
for (const item of ["index.js", "dist", "native", "examples", "package.json"])
  fs.cpSync(path.join(repository, item), path.join(plugin, item), { recursive: true })
fs.rmSync(stateDir, { recursive: true, force: true })
fs.mkdirSync(stateDir, { recursive: true })
fs.writeFileSync(
  path.join(stateDir, "settings.json"),
  JSON.stringify({
    rules: [{ id: "smoke-files", plugin: "guard-smoke", kind: "filesystem", action: "deny" }],
    baseline: { enabled: true },
  }),
)
const probe = path.join(root, "plugins", "guard-smoke")
fs.mkdirSync(probe, { recursive: true })
fs.writeFileSync(
  path.join(probe, "index.js"),
  `import fs from "node:fs"
import http from "node:http"
import { execFile } from "node:child_process"
const say = (...args) => console.log("[SMOKE]", ...args)
export class GuardSmoke extends plugin {
  constructor() {
    super({ name: "GuardSmoke", event: "message", priority: 5000, rule: [] })
  }
  async init() {
    if (!globalThis[Symbol.for("yunzai.guard.context.v1")]) return
    setTimeout(async () => {
      try {
        fs.mkdirSync("data/guard-smoke", { recursive: true })
        say("files", "ok")
      } catch (error) {
        say("files", error.code)
      }
      const server = http.createServer(() => {}).listen(0, "127.0.0.1", () => {
        say("listen", "ok")
        server.close()
      })
      execFile(process.execPath, ["-v"], (error, out) => say("exec", error ? error.code : out.trim()))
      setTimeout(() => say("done"), 2000)
    }, 2000)
  }
}
`,
)

const output = fs.openSync(path.join(root, "smoke-app.log"), "w")
if (usePm2) {
  console.log(`PM2 ${pm2("-v").stdout.trim()}`)
  const started = pm2("start", "app.js", "--name", "guard-smoke")
  if (started.status !== 0) throw new Error(`pm2 start 失败：${started.stderr}`)
} else {
  const app = spawn(process.execPath, ["app.js"], {
    cwd: root,
    stdio: ["ignore", output, output],
    detached: process.platform !== "win32",
  })
  app.unref()
}
/** 探针完成的次数，每启动一代业务进程加一。 */
const rounds = () =>
  fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("[SMOKE] done").length - 1 : 0
let failure
try {
  await until(
    () => fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("[SMOKE] done"),
    240000,
    "探针完成",
  )
  const text = fs.readFileSync(log, "utf8")
  const lines = text.split("\n").filter(line => line.includes("[SMOKE]"))
  console.log(lines.join("\n"))
  if (!lines.some(line => /\[SMOKE\] files GUARD_DENIED/.test(line)))
    throw new Error("文件拒绝规则没有生效")
  if (!lines.some(line => /\[SMOKE\] listen ok/.test(line))) throw new Error("端口监听探测失败")
  const current = status()
  console.log(
    `状态：${current?.phase} 第 ${current?.generation} 代 宿主 ${current?.hostPid} 业务 ${current?.workerPid}`,
  )
  if (current?.phase !== "online" || !current.workerPid) throw new Error("Guard 没有在线")
  if (usePm2) {
    if (pm2("restart", "guard-smoke").status !== 0) throw new Error("pm2 restart 失败")
    await until(() => rounds() >= 2 && status()?.phase === "online", 180000, "PM2 重启后重新接管")
    console.log("pm2 restart 后重新接管并上线")
  } else {
    const restarted = spawnSync(
      process.execPath,
      [path.join(plugin, "dist", "cli.js"), "restart"],
      { cwd: root },
    )
    if (restarted.status !== 0) throw new Error("restart 命令失败")
    await until(
      () => status()?.generation === 2 && status()?.phase === "online",
      120000,
      "重启后上线",
    )
    console.log("CLI restart 后重建为第 2 代")
  }
} catch (error) {
  failure = error
  console.error(fs.existsSync(log) ? fs.readFileSync(log, "utf8").slice(-6000) : "(没有 host.log)")
  console.error(fs.readFileSync(path.join(root, "smoke-app.log"), "utf8").slice(-4000))
} finally {
  if (usePm2) {
    if (!failure)
      console.log(
        pm2("jlist").stdout.includes('"status":"online"') ? "PM2 显示在线" : "PM2 状态异常",
      )
    pm2("stop", "guard-smoke")
    await sleep(5000)
    if (!failure && status()?.phase) failure = new Error("pm2 stop 后 Guard 仍在运行")
    pm2("delete", "guard-smoke")
    pm2("kill")
  } else {
    spawnSync(process.execPath, [path.join(plugin, "dist", "cli.js"), "stop"], { cwd: root })
    await sleep(5000)
  }
}
if (failure) throw failure
console.log("冒烟通过")
