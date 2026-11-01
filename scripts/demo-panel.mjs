import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const owner = "yunzai-guard-panel-demo-v1"
const markerName = ".guard-panel-demo.json"
const repository = fileURLToPath(new URL("../", import.meta.url))
const { values } = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    port: { type: "string" },
    scenario: { type: "string", default: "default" },
    "ready-file": { type: "string" },
    "persist-dir": { type: "string" },
  },
})

if (values.help) {
  console.log(`Usage: npm run dev:demo -- [options]
  --port <1024-65535>          默认使用空闲端口
  --scenario <name>           default | startup | apply-failure
  --ready-file <file>         输出地址、登录链接和进程信息
  --persist-dir <directory>   保留 demo 数据；只接受空目录或已标记的 demo 目录

仅监听 127.0.0.1。默认数据目录在系统临时目录，退出时清理。
输入 login 获取新登录链接；输入 stop 或按 Ctrl+C 退出。`)
} else {
  await main().catch(error => {
    console.error(`[demo] ${error.message}`)
    process.exitCode = 1
  })
}

async function main() {
  if (!["default", "startup", "apply-failure"].includes(values.scenario))
    throw new Error("无效场景：default | startup | apply-failure")
  const requestedPort = values.port === undefined ? 0 : Number(values.port)
  if (
    requestedPort !== 0 &&
    (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535)
  )
    throw new Error("端口范围：1024-65535")
  const modules = await Promise.all([
    import("../dist/web/server.js"),
    import("../dist/web/panel-settings.js"),
    import("../dist/config/index.js"),
    import("../dist/config/settings-file.js"),
    import("../dist/host/settings.js"),
    import("../dist/host/alerts.js"),
    import("../dist/host/profile.js"),
  ]).catch(() => {
    throw new Error("缺少构建产物，请先运行 npm run build")
  })
  const [
    { GuardPanel },
    { savePanelSettings },
    { parseSettings },
    files,
    { SettingsController },
    { AlertService },
    { BehaviorProfile },
  ] = modules
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const persistent = values["persist-dir"] !== undefined
  const root = persistent
    ? path.resolve(values["persist-dir"])
    : fs.mkdtempSync(path.join(temporaryRoot, "yunzai-guard-demo-"))
  prepareRoot(root)
  const stateDir = path.join(root, "data", "yunzai-guard")
  fs.mkdirSync(stateDir, { recursive: true })
  const readyFile = values["ready-file"] ? path.resolve(values["ready-file"]) : undefined
  let panel, alerts, profiles, applyTimer, resourceTimer
  let stopping = false
  const scenario = values.scenario
  let generation = 1,
    workerRestarts = 0,
    applyAttempts = 0,
    failures = 0
  let phase = scenario === "startup" ? "tripped" : "online"
  let trippedReason = scenario === "startup" ? "示例启动失败，已停止自动恢复" : undefined
  let failNext = false
  let sequence = 0
  let applyQueue = Promise.resolve()
  const points = []
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const log = message =>
    fs.appendFileSync(path.join(stateDir, "host.log"), `[${new Date().toISOString()}] ${message}\n`)
  const record = (type, details = {}) =>
    fs.appendFileSync(
      path.join(stateDir, "events.jsonl"),
      JSON.stringify({
        type,
        time: Date.now(),
        hostPid: process.pid,
        generation,
        sequence: ++sequence,
        details,
      }) + "\n",
    )

  try {
    for (const [id, description] of [
      ["miao-plugin", "喵喵插件 · 示例"],
      ["genshin-plugin", "游戏功能 · 示例"],
      ["media-plugin", "图片与视频 · 示例"],
      ["quiet-plugin", "无拦截记录 · 示例"],
    ]) {
      const directory = path.join(root, "plugins", id)
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(
        path.join(directory, "package.json"),
        JSON.stringify({ name: id, description }, null, 2) + "\n",
      )
    }
    const initial = parseSettings({
      baseline: { enabled: true },
      rules: [
        { id: "demo.network", kind: "network", action: "deny" },
        { id: "demo.commands", kind: "process", action: "deny" },
        { id: "demo.file-write", plugin: "media-plugin", kind: "filesystem", action: "deny" },
      ],
    })
    const saved = files.readSettingsSource(stateDir)
    const settings = saved ? parseSettings(files.parseSettingsSource(saved)) : initial
    if (!saved)
      files.writeSettingsText(
        stateDir,
        "# 独立面板 demo，修改只写入此目录。\n" + files.renderSettings(settings),
      )

    const restartWorker = async () => {
      phase = "starting"
      workerRestarts++
      log("[INFO] DEMO 业务重启")
      await wait(450)
      if (stopping) return
      generation++
      phase = "online"
      trippedReason = undefined
      failures = 0
      log("[INFO] DEMO 业务已上线")
    }
    const controller = new SettingsController(settings, {
      prepare: async () => {
        await wait(120)
      },
      applyLive: async () => {
        await wait(100)
      },
      reload: async () => {
        applyAttempts++
        if (failNext) {
          failNext = false
          failures++
          log("[ERROR] DEMO 配置应用失败：示例依赖未就绪")
          throw new Error("示例依赖未就绪")
        }
        await restartWorker()
      },
    })
    const applySettings = next => {
      const state = controller.request(next)
      if (!applyTimer)
        applyTimer = setTimeout(() => {
          applyTimer = undefined
          applyQueue = applyQueue
            .then(async () => {
              while (!stopping && controller.hasPending) await controller.applyPending()
            })
            .catch(error => log(`[ERROR] ${error.message}`))
        }, 80)
      return state
    }
    alerts = new AlertService({
      settings: () => ({
        ...controller.active,
        alerts: {
          ...controller.active.alerts,
          webhook: { ...controller.active.alerts.webhook, url: "" },
        },
      }),
      stateDir,
      projectId: "panel-demo",
      send: () => true,
      record,
    })
    alerts.testWebhook = async () => ({ ok: false, error: "DEMO 不发送 Webhook" })
    profiles = new BehaviorProfile({
      file: path.join(stateDir, "profiles.json"),
      settings: () => controller.active.baseline,
    })
    if (!fs.existsSync(path.join(stateDir, "demo-seeded.json"))) {
      const now = Date.now()
      const samples = [
        ["miao-plugin", "network", "fetch", "https://api.example.test/profile", "demo.network", 18],
        [
          "miao-plugin",
          "network",
          "fetch",
          "https://images.example.test/avatar",
          "demo.network",
          6,
        ],
        [
          "miao-plugin",
          "network",
          "https.request",
          "https://api.example.test/token",
          "demo.network",
          3,
        ],
        [
          "genshin-plugin",
          "network",
          "fetch",
          "https://updates.example.test/version",
          "demo.network",
          4,
        ],
        ["media-plugin", "process", "spawn", "ffmpeg", "demo.commands", 2],
        [
          "media-plugin",
          "filesystem",
          "fs.writeFile",
          "data/media/cache.json",
          "demo.file-write",
          2,
        ],
        ["unknown", "network", "fetch", "https://unknown.example.test/check", "demo.network", 1],
      ]
      const rows = []
      for (const [plugin, kind, operation, target, ruleId, count] of samples) {
        for (let index = 0; index < count; index++) {
          const time = now - (count - index) * 23000 - sequence * 190
          rows.push({
            type: "audit",
            time,
            hostPid: process.pid,
            generation,
            sequence: ++sequence,
            event: {
              plugin,
              kind,
              operation,
              target,
              ruleId,
              action: "deny",
              blocked: true,
              details: { demo: true },
            },
          })
          profiles.observe({ plugin, kind, target, time })
        }
      }
      fs.appendFileSync(
        path.join(stateDir, "events.jsonl"),
        rows.map(row => JSON.stringify(row)).join("\n") + "\n",
      )
      profiles.endLearning()
      profiles.flush()
      alerts.raise("deny", "miao-plugin 请求被拦截", "api.example.test · 网络访问", {
        plugin: "miao-plugin",
        key: "demo-deny",
      })
      alerts.raise("deny", "media-plugin 命令被拦截", "ffmpeg · 外部命令", {
        plugin: "media-plugin",
        key: "demo-media",
      })
      fs.writeFileSync(path.join(stateDir, "demo-seeded.json"), JSON.stringify({ at: now }) + "\n")
    }
    log(`[INFO] DEMO 场景：${scenario}`)
    if (trippedReason) log("[ERROR] DEMO 启动失败：示例插件初始化失败")
    const sampleResources = () => {
      const rss = process.memoryUsage().rss
      points.push({
        time: Date.now(),
        processes: phase === "online" ? 1 : 0,
        rssBytes: phase === "online" ? 132 * 1024 * 1024 : 0,
        cpu: phase === "online" ? 0.8 : 0,
        hostRssBytes: rss,
        hostCpu: 0.1,
        hostLagMs: 0.4,
      })
      if (points.length > 60) points.shift()
    }
    sampleResources()
    resourceTimer = setInterval(sampleResources, 3000)
    const port = requestedPort || (await availablePort())
    savePanelSettings(stateDir, {
      enabled: true,
      host: "127.0.0.1",
      port,
      allowExternal: false,
      publicUrl: "",
      chatLogin: true,
    })
    const version = JSON.parse(
      fs.readFileSync(path.join(repository, "package.json"), "utf8"),
    ).version
    panel = new GuardPanel({
      root,
      stateDir,
      settings,
      version: `${version}-demo`,
      getSettings: () => controller.active,
      configuration: () => controller.state,
      applySettings,
      status: () => ({
        phase,
        hostPid: process.pid,
        workerPid: phase === "online" ? 90000 + generation : undefined,
        generation,
        recoveryCount: failures || (trippedReason ? 3 : 0),
        trippedReason,
        demo: { workerRestarts, applyAttempts, scenario },
        monitoring: { targets: [] },
      }),
      audit: record,
      controllers: {
        alerts,
        profiles,
        sources: { list: () => [], scan: async () => [] },
        resources: { points: () => [...points] },
      },
      restart: () => {
        void restartWorker()
      },
      resume: () => {
        void restartWorker()
      },
      log: message => log(message),
    })
    if (!(await panel.start())) throw new Error("demo 启动失败")
    const baseUrl = `http://127.0.0.1:${panel.port}`
    if (!fs.existsSync(path.join(stateDir, "demo-history-seeded.json"))) {
      await seedHistory(panel, baseUrl, controller)
      fs.writeFileSync(
        path.join(stateDir, "demo-history-seeded.json"),
        JSON.stringify({ at: Date.now() }) + "\n",
      )
    }
    if (scenario === "apply-failure") {
      failNext = true
      const desired = parseSettings({
        ...controller.active,
        monitor: {
          ...controller.active.monitor,
          files: controller.active.monitor.files === "all" ? "write" : "all",
        },
      })
      files.writeSettingsText(stateDir, files.renderSettings(desired))
      controller.request(desired)
      await controller.applyPending()
    }
    const ready = {
      type: "guard-panel-demo-ready",
      baseUrl,
      loginUrl: panel.loginLink().urls[0],
      root,
      stateDir,
      pid: process.pid,
      scenario,
      persistent,
    }
    if (readyFile) {
      fs.mkdirSync(path.dirname(readyFile), { recursive: true })
      fs.writeFileSync(readyFile, JSON.stringify(ready, null, 2) + "\n", { mode: 0o600 })
    }
    console.log(JSON.stringify(ready))
    await new Promise(resolve => {
      const onData = input => {
        for (const command of String(input).trim().split(/\s+/)) {
          if (command === "stop") {
            finish()
            return
          }
          if (command === "login") {
            ready.loginUrl = panel.loginLink().urls[0]
            if (readyFile)
              fs.writeFileSync(readyFile, JSON.stringify(ready, null, 2) + "\n", { mode: 0o600 })
            console.log(JSON.stringify(ready))
          }
        }
      }
      const finish = () => {
        process.off("SIGINT", finish)
        process.off("SIGTERM", finish)
        process.stdin.off("data", onData)
        process.stdin.pause()
        process.stdin.unref?.()
        resolve()
      }
      process.once("SIGINT", finish)
      process.once("SIGTERM", finish)
      process.stdin.on("data", onData)
    })
  } finally {
    stopping = true
    clearTimeout(applyTimer)
    clearInterval(resourceTimer)
    await panel?.stop()
    await applyQueue
    alerts?.stop()
    profiles?.flush()
    if (readyFile) {
      try {
        if (JSON.parse(fs.readFileSync(readyFile, "utf8")).pid === process.pid) fs.rmSync(readyFile)
      } catch {}
    }
    if (!persistent) {
      const resolved = fs.realpathSync(root)
      const marker = JSON.parse(fs.readFileSync(path.join(root, markerName), "utf8"))
      if (
        path.dirname(resolved) !== temporaryRoot ||
        !path.basename(resolved).startsWith("yunzai-guard-demo-") ||
        marker.owner !== owner
      )
        throw new Error("demo 目录校验失败，已保留数据")
      fs.rmSync(resolved, { recursive: true, force: true })
    }
  }
}

function prepareRoot(root) {
  if (
    path.resolve(root) === path.resolve(repository) ||
    /(?:^|[\\/])data[\\/]yunzai-guard$/i.test(root)
  )
    throw new Error("请使用独立 demo 目录")
  if (fs.existsSync(root)) {
    if (fs.lstatSync(root).isSymbolicLink() || !fs.statSync(root).isDirectory())
      throw new Error("demo 路径必须是目录")
    const marker = path.join(root, markerName)
    if (
      fs.readdirSync(root).length &&
      (!fs.existsSync(marker) || JSON.parse(fs.readFileSync(marker, "utf8")).owner !== owner)
    )
      throw new Error("目录非空且不属于 demo")
  } else fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(
    path.join(root, markerName),
    JSON.stringify({ owner, createdAt: Date.now() }) + "\n",
    { mode: 0o600 },
  )
}

async function availablePort() {
  const probe = net.createServer()
  await new Promise((resolve, reject) => {
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", resolve)
  })
  const port = probe.address().port
  await new Promise((resolve, reject) => probe.close(error => (error ? reject(error) : resolve())))
  return port
}

async function seedHistory(panel, baseUrl, controller) {
  const loginUrl = new URL(panel.loginLink().urls[0])
  const token = loginUrl.hash.slice("#login=".length)
  const response = await fetch(`${baseUrl}/api/login/link`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
      "User-Agent": "Guard Panel Demo",
    },
    body: JSON.stringify({ token }),
  })
  if (!response.ok) throw new Error("demo 登录失败")
  const session = await response.json()
  const cookie = response.headers.get("set-cookie").split(";")[0]
  const headers = {
    Cookie: cookie,
    "x-guard-csrf": session.csrfToken,
    "Content-Type": "application/json",
    Origin: baseUrl,
  }
  const original = controller.active.alerts.enabled
  for (const [enabled, title] of [
    [!original, "示例：切换告警"],
    [original, "示例：恢复告警"],
  ]) {
    const current = await (await fetch(`${baseUrl}/api/settings`, { headers })).json()
    const document = { ...current.normalized, alerts: { ...current.normalized.alerts, enabled } }
    const saved = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ document, revision: current.revision, title }),
    })
    if (!saved.ok) throw new Error("demo 操作记录初始化失败")
    await saved.json()
    const deadline = Date.now() + 5000
    while (controller.state.status === "applying" && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 80))
    if (controller.state.status === "applying") throw new Error("demo 配置应用超时")
    await (await fetch(`${baseUrl}/api/settings`, { headers })).json()
  }
}
