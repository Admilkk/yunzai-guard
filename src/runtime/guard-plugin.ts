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

/** 主人命令已识别：从 dealEvent 抛出，由外层 deal 钩子接住并结束本次分派。 */
class Intercepted {
  constructor(
    readonly event: object,
    readonly command: GuardCommand,
  ) {}
}

/**
 * 接管 Guard 自有插件：核心加载 Guard 入口时换成运行时子类，监控与策略不再统计它。
 * 主人命令在 dealEvent 算出 e.msg 与 e.isMaster 后立即处理并结束分派，
 * 先于上下文、仅响应 @、分派前钩子与全部插件；只有黑白名单与冷却仍在其前。
 * 子类以最高优先级在 accept 中分派受限脚本；命令能力只留在本模块闭包内。
 */
export function attachGuardPlugin(hooks: LoaderHooks, options: GuardPluginOptions): void {
  const entry = located(options.loaderDirectory, options.entry)
  if (!entry) return
  const intercepting =
    hooks.around("deal", async (next, event: Row, ...args: unknown[]) => {
      try {
        return await next(event, ...args)
      } catch (error) {
        if (!(error instanceof Intercepted) || error.event !== event) throw error
        options.command(error.command)
        await event.reply?.(replies[error.command])
      }
    }) &&
    hooks.around("dealEvent", (next, event: Row, ...args: unknown[]) => {
      const result = next(event, ...args)
      const command = parseGuardCommand(event?.msg)
      // 主人身份沿用核心刚算出的 e.isMaster；直接调用 dealEvent 的伪造事件只会收到异常。
      if (command && event.isMaster === true) throw new Intercepted(event, command)
      return result
    })

  const own = (file: Row) => located(options.loaderDirectory, file?.path) === entry
  hooks.trustWhen(own)
  hooks.around("loadPlugin", (next, file: Row, constructor: unknown) => {
    if (typeof constructor !== "function" || !hooks.trusted(file?.name) || !own(file))
      return next(file, constructor)
    const base = constructor as new (...args: any[]) => Row
    class GuardPlugin extends base {
      constructor(...args: any[]) {
        super(...args)
        this.priority = -Infinity
        // 命令已在分派前处理，规则留空；无法拦截时保留入口插件的兜底规则。
        if (intercepting) this.rule = []
      }

      async accept(event: Row) {
        return (await options.dispatch(event)) ? "return" : false
      }
    }
    return next(file, GuardPlugin)
  })
}
