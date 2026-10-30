/** 主人命令。入口插件的兜底规则与运行时接管共用同一组匹配，不区分大小写。 */
export type GuardCommand = "update" | "force-update" | "rollback" | "login"

export const guardCommandPatterns: Readonly<Record<GuardCommand, RegExp>> = Object.freeze({
  update: /^#?guard更新$/i,
  "force-update": /^#?guard强制更新$/i,
  rollback: /^#?guard(?:回滚|还原)$/i,
  login: /^#?guard(?:登录|登陆|登入|面板)$/i,
})

const commands = Object.keys(guardCommandPatterns) as GuardCommand[]

/** 识别消息文本对应的命令。 */
export function parseGuardCommand(text: unknown): GuardCommand | undefined {
  if (typeof text !== "string") return undefined
  return commands.find(command => guardCommandPatterns[command].test(text))
}
