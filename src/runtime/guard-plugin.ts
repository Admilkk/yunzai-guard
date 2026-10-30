import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { LoaderHooks } from "../monitor/loader-hooks.js"
import { parseGuardCommand, type GuardCommand } from "../shared/commands.js"
import { M } from "../shared/messages.js"

type Row = Record<string, any>

export interface GuardPluginOptions {
  /** Guard 入口文件 index.js。 */
  entry: string
  /** 核心加载器文件所在目录；插件路径相对它解析。 */
  loaderDirectory: string
  /** 把主人命令交给宿主。 */
  command: (command: GuardCommand) => void
  /** 交给受限脚本分派，已处理时返回 true。 */
  dispatch: (event: Row) => Promise<boolean>
}

const replies: Readonly<Record<GuardCommand, string>> = Object.freeze({
  update: M.entry.updateRequested,
  "force-update": M.entry.updateForced,
  rollback: M.entry.rollbackRequested,
  login: M.entry.loginSent,
})

/** 解析插件条目的真实路径；无法解析时返回 undefined。 */
function located(directory: string, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  try {
    const file = value.split(/[?#]/)[0]
    return fs.realpathSync.native(
      file.startsWith("file:") ? fileURLToPath(file) : path.resolve(directory, file),
    )
  } catch {
    return undefined
  }
}

/**
 * 接管 Guard 自有插件：核心加载 Guard 入口时换成运行时子类，监控与策略不再统计它。
 * 子类以最高优先级在 accept 中先处理主人命令，再分派受限脚本；命令能力只留在本模块闭包内。
 * 主人身份沿用核心算出的 e.isMaster，且只认核心 deal 实际分派的事件，插件伪造的事件对象无效。
 */
export function attachGuardPlugin(hooks: LoaderHooks, options: GuardPluginOptions): void {
  const entry = located(options.loaderDirectory, options.entry)
  const live = new WeakSet()
  const tracked = hooks.around("deal", (next, event: unknown, ...args: unknown[]) => {
    if (event && typeof event === "object") live.add(event)
    return next(event, ...args)
  })
  // 无法确认事件来源时不接管，保留入口插件的兜底规则。
  if (!entry || !tracked) return

  /** 处理一条消息；返回 "return" 时核心停止后续分派。 */
  async function accept(event: Row): Promise<"return" | false> {
    const command = parseGuardCommand(event?.msg)
    if (command) {
      if (!live.has(event) || event.isMaster !== true) return false
      // 每个事件只触发一次，避免插件拿到主人消息后重复调用。
      live.delete(event)
      options.command(command)
      await event.reply?.(replies[command])
      return "return"
    }
    return (await options.dispatch(event)) ? "return" : false
  }

  const own = (file: Row) => located(options.loaderDirectory, file?.path) === entry
  hooks.around("importPlugin", (next, file: Row, ...args: unknown[]) => {
    if (own(file)) hooks.trust(file.name)
    return next(file, ...args)
  })
  hooks.around("loadPlugin", (next, file: Row, constructor: unknown) => {
    if (typeof constructor !== "function" || !hooks.trusted(file?.name) || !own(file))
      return next(file, constructor)
    const base = constructor as new (...args: any[]) => Row
    class GuardPlugin extends base {
      constructor(...args: any[]) {
        super(...args)
        // 命令改在 accept 中处理，规则留空以免与其他插件重复匹配。
        this.priority = -Infinity
        this.rule = []
      }

      accept(event: Row) {
        return accept(event)
      }
    }
    return next(file, GuardPlugin)
  })
}
