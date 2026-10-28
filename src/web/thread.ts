import { parentPort, workerData } from "node:worker_threads"
import { panelHandover, panelLoginLink, panelVersion, startPanel, stopPanel } from "./index.js"
import {
  asyncCaller,
  coreProtocolVersion,
  serializeError,
  syncCaller,
  type CoreCommand,
  type CoreEvent,
  type CoreThreadData,
} from "./core-protocol.js"
import type { StartPanelOptions } from "./index.js"
import type { PanelControllers, UpdateController } from "./controllers.js"
import type { GuardSettings } from "../shared/types.js"
import type { SettingsApplyState } from "../config/update.js"

/**
 * 控制台线程入口：控制台服务运行在宿主进程的独立线程里，宿主更新控制台时只需换掉这个线程，
 * 业务进程不受影响。所有宿主能力都经调用协议转发，线程本身不持有业务进程或审计管道。
 */
const data = workerData as CoreThreadData
const port = parentPort
if (!port || data?.protocol !== coreProtocolVersion) throw new Error("控制台线程协议不匹配")
const call = syncCaller(data.syncPort, data.signal)
const callAsync = asyncCaller(data.asyncPort)
const emit = (event: CoreEvent): void => port.postMessage(event)

const controllers: PanelControllers = {
  alerts: {
    history: limit =>
      call("alerts.history", limit) as ReturnType<PanelControllers["alerts"]["history"]>,
    testWebhook: () =>
      callAsync("alerts.testWebhook") as ReturnType<PanelControllers["alerts"]["testWebhook"]>,
    state: () => call("alerts.state") as ReturnType<PanelControllers["alerts"]["state"]>,
    acknowledge: ids => void call("alerts.acknowledge", ids),
    mute: (target, minutes) =>
      call("alerts.mute", target, minutes) as ReturnType<PanelControllers["alerts"]["mute"]>,
    unmute: key => void call("alerts.unmute", key),
    raise: (...args) => void call("alerts.raise", ...args),
  },
  profiles: {
    summary: (...args) =>
      call("profiles.summary", ...args) as ReturnType<PanelControllers["profiles"]["summary"]>,
    detail: (...args) =>
      call("profiles.detail", ...args) as ReturnType<PanelControllers["profiles"]["detail"]>,
    trust: (...args) =>
      call("profiles.trust", ...args) as ReturnType<PanelControllers["profiles"]["trust"]>,
    forget: (...args) =>
      call("profiles.forget", ...args) as ReturnType<PanelControllers["profiles"]["forget"]>,
    endLearning: (...args) =>
      call("profiles.endLearning", ...args) as ReturnType<
        PanelControllers["profiles"]["endLearning"]
      >,
    reset: (...args) =>
      call("profiles.reset", ...args) as ReturnType<PanelControllers["profiles"]["reset"]>,
  },
  sources: {
    list: () => call("sources.list") as ReturnType<PanelControllers["sources"]["list"]>,
    scan: () => callAsync("sources.scan") as ReturnType<PanelControllers["sources"]["scan"]>,
  },
  resources: {
    points: () => call("resources.points") as ReturnType<PanelControllers["resources"]["points"]>,
  },
}

const update: UpdateController = {
  state: () => call("update.state") as ReturnType<UpdateController["state"]>,
  check: () => callAsync("update.check") as ReturnType<UpdateController["check"]>,
  apply: force => callAsync("update.apply", force) as ReturnType<UpdateController["apply"]>,
  rollback: () => callAsync("update.rollback") as ReturnType<UpdateController["rollback"]>,
  applyPending: () =>
    callAsync("update.applyPending") as ReturnType<UpdateController["applyPending"]>,
}

const options: StartPanelOptions = {
  root: data.root,
  stateDir: data.stateDir,
  settings: data.settings as GuardSettings,
  getSettings: () => call("getSettings") as GuardSettings,
  configuration: () => call("configuration") as SettingsApplyState,
  applySettings: next => call("applySettings", next) as SettingsApplyState,
  status: () => call("status") as Record<string, unknown>,
  update,
  controllers,
  restart: () => void call("restart"),
  resume: () => void call("resume"),
  audit: (type, details) => void call("audit", type, details),
  handover: data.handover,
}

port.on("message", (command: CoreCommand) => {
  if (command?.type === "stop") {
    const handover = panelHandover()
    void stopPanel().finally(() => emit({ type: "stopped", handover }))
    return
  }
  if (command?.type === "login-link") {
    try {
      emit({
        type: "login-link-result",
        reply: { id: command.id, ok: true, value: panelLoginLink() },
      })
    } catch (error) {
      emit({
        type: "login-link-result",
        reply: { id: command.id, ok: false, error: serializeError(error) },
      })
    }
  }
})

const listening = await startPanel(options)
emit({ type: "ready", listening, version: panelVersion() })
