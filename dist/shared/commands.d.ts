/** 主人命令。入口插件的兜底规则与运行时接管共用同一组匹配，不区分大小写。 */
export type GuardCommand = "update" | "force-update" | "rollback" | "login";
export declare const guardCommandPatterns: Readonly<Record<GuardCommand, RegExp>>;
/** 识别消息文本对应的命令。 */
export declare function parseGuardCommand(text: unknown): GuardCommand | undefined;
