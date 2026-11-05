import { analyzeCommand } from "./command-analysis.js"
import { Paths } from "./paths.js"
import { arrayEach } from "./intrinsics.js"

export interface CommandGuardOptions {
  roots: string[]
  deny(operation: string, target: string): never
}

/** 仅拒绝能够明确识别的 Guard 写入目标，解析不足与进程类型不构成拒绝理由。 */
export function createCommandGuard(options: CommandGuardOptions) {
  const writes = new Paths(options.roots, options.deny)
  return (operation: string, args: readonly unknown[]): void => {
    const analysis = analyzeCommand(operation, args)
    arrayEach(analysis.targets, target => {
      if (target.access === "write")
        writes.check(target.raw ?? target.path, operation, target.ancestors)
    })
  }
}
