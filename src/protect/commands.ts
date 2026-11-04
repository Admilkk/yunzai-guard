import { GuardDeniedError, evaluatePolicy } from "../config/policy.js"
import type { EmitEvent, GuardSettings } from "../shared/types.js"
import { analyzeCommand } from "./command-analysis.js"
import { Paths } from "./paths.js"
import { apply, arrayEach, stringSlice, timestamp } from "./intrinsics.js"

const replaceText = String.prototype.replace
const auditTarget = (value: string): string =>
  stringSlice(apply(replaceText, value, [/[\x00-\x1f\x7f]/g, ""]), 0, 512)

export interface CommandGuardOptions {
  roots: string[]
  readRoots: string[]
  settings: GuardSettings
  deny(operation: string, target: string): never
  emit: EmitEvent
  originPlugin(): string | undefined
}

/** 固定文件保护先于业务策略；脚本只在没有显式规则时默认拒绝。 */
export function createCommandGuard(options: CommandGuardOptions) {
  const writes = new Paths(options.roots, options.deny)
  const reads = new Paths(options.readRoots, options.deny)
  return (operation: string, args: readonly unknown[]): void => {
    const analysis = analyzeCommand(operation, args)
    if (analysis.limited) options.deny(operation, "unresolved-command")
    arrayEach(analysis.targets, target => {
      const paths = target.access === "read" ? reads : writes
      paths.check(target.raw ?? target.path, operation, target.ancestors)
    })
    if (!analysis.script) return
    let plugin = "unknown"
    try {
      plugin = options.originPlugin() ?? "unknown"
    } catch {
      // 无法归因时仍执行默认脚本策略。
    }
    const event = {
      kind: "process",
      operation,
      target: typeof args[0] === "string" ? args[0] : analysis.executable,
      plugin,
      details: { scriptExecution: true },
    }
    const decision = evaluatePolicy(options.settings, event)
    if (decision.action === "audit") return
    try {
      options.emit({
        ...event,
        ...decision,
        target: auditTarget(analysis.executable),
        timestamp: timestamp(),
        details: {
          scriptExecution: true,
          argumentsRedacted: true,
          blocked: true,
          result: "blocked",
        },
      })
    } catch {
      // 记录失败不能放行默认禁止的脚本。
    }
    throw new GuardDeniedError(operation, decision.ruleId)
  }
}
