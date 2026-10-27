import { matchGlob } from "../config/policy.js"
import type { EmitEvent, GuardSettings } from "../shared/types.js"
import { SandboxExecutor } from "./executor.js"
import { sandboxWriteTarget, writeSandboxText } from "./filesystem.js"
import type { SandboxAction, SandboxEvent, SandboxSource } from "./types.js"

import { validateSandboxActions, sandboxEvent } from "./actions.js"
import { sandboxDecision } from "./policy.js"
import { M } from "../shared/messages.js"
export { validateSandboxActions, sandboxEvent } from "./actions.js"

export class SandboxDispatcher {
  readonly #executor = new SandboxExecutor()
  readonly #busy = new Set<string>()
  #closed = false
  /** 创建受限脚本分派器。 */
  constructor(
    readonly root: string,
    readonly settings: GuardSettings,
    readonly sources: SandboxSource[],
    readonly emit: EmitEvent,
    readonly log: (id: string, text: string) => void,
  ) {}

  /** 预热执行器，确认脚本可加载。 */
  async ready(): Promise<void> {
    if (!this.sources.length) return
    const result = await this.#executor.execute(
      { ...this.sources[0]!, capabilities: [], source: "globalThis.onMessage = () => {}" },
      { message: "", userId: "", groupId: "", selfId: "", isGroup: false },
      this.settings.pluginSandbox,
    )
    if (!result.ok) throw new Error(M.pluginSandbox.selfTest(result.code))
  }

  /** 上报受限脚本违规事件。 */
  #violation(plugin: SandboxSource, code: string): void {
    const event = {
      kind: "plugin-sandbox",
      plugin: plugin.id,
      operation: "sandbox.violation",
      target: code,
    }
    const decision = sandboxDecision(this.settings, plugin, event)
    this.emit({
      ...event,
      ...decision,
      action: decision.ruleId ? decision.action : plugin.violationAction,
    })
  }

  /** 把消息分派给匹配的受限脚本，返回是否已处理。 */
  async dispatch(original: Record<string, unknown>): Promise<boolean> {
    if (!this.sources.length) return false
    const event = sandboxEvent(original)
    const plugin = this.sources.find(
      item => item.enabled !== false && matchGlob(item.match, event.message),
    )
    if (!plugin) return false
    if (this.#closed || this.#busy.has(plugin.id)) {
      this.emit({
        kind: "plugin-sandbox",
        plugin: plugin.id,
        operation: "sandbox.admission",
        target: "busy-or-closed",
        action: "audit",
      })
      return true
    }
    this.#busy.add(plugin.id)
    try {
      const outcome = await this.#executor.execute(plugin, event, this.settings.pluginSandbox)
      if (this.#closed) return true
      if (outcome?.attempts) {
        if (outcome.attempts.length > 32) throw new Error(M.pluginSandbox.attemptBudget)
        for (const attempt of outcome.attempts) {
          if (
            attempt.operation !== "sandbox.hook" ||
            typeof attempt.target !== "string" ||
            attempt.target.length > 256
          )
            throw new Error(M.pluginSandbox.hookReport)
          const event = {
            kind: "plugin-sandbox",
            plugin: plugin.id,
            operation: "sandbox.hook",
            target: attempt.target,
          }
          const decision = sandboxDecision(this.settings, plugin, event)
          const action = decision.ruleId ? decision.action : plugin.hookAction
          this.emit({ ...event, ...decision, action, details: { blocked: true } })
          if (action !== "audit") return true
        }
      }
      if (!outcome?.ok) {
        if (["executor-unavailable", "executor-closed"].includes(outcome?.code))
          this.emit({
            kind: "plugin-sandbox",
            plugin: plugin.id,
            operation: "sandbox.admission",
            target: outcome.code,
            action: "audit",
          })
        else this.#violation(plugin, outcome?.code ?? "invalid-result")
        return true
      }
      const actions = validateSandboxActions(outcome, plugin)
      // 产生业务副作用前，先检查全部授权、规则和目标文件。
      for (const action of actions) {
        const row = {
          kind: "plugin-sandbox",
          plugin: plugin.id,
          operation: `sandbox.${action.capability}`,
          target: action.file ?? "message",
        }
        const decision = sandboxDecision(this.settings, plugin, row)
        this.emit({ ...row, ...decision })
        if (decision.action !== "audit") return true
        if (action.capability === "writeText")
          sandboxWriteTarget(this.root, plugin.id, action.file!, false)
        if (action.capability === "reply" && typeof original.reply !== "function")
          throw new Error("reply-unavailable")
      }
      for (const action of actions) {
        if (this.#closed) return true
        if (action.capability === "writeText")
          writeSandboxText(this.root, plugin.id, action.file!, action.text)
        else if (action.capability === "reply")
          await Reflect.apply(original.reply as Function, original, [action.text])
        else this.log(plugin.id, action.text)
      }
      this.emit({
        kind: "plugin-sandbox",
        plugin: plugin.id,
        operation: "sandbox.complete",
        target: "message",
        action: "audit",
      })
    } catch {
      this.#violation(plugin, "broker-denied")
    } finally {
      this.#busy.delete(plugin.id)
    }
    return true
  }

  /** 关闭分派器与执行器。 */
  async close(): Promise<void> {
    this.#closed = true
    await this.#executor.close()
  }
}
