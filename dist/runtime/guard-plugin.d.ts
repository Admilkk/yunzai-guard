import type { LoaderHooks } from "../monitor/loader-hooks.js";
import { type GuardCommand } from "../shared/commands.js";
type Row = Record<string, any>;
export interface GuardPluginOptions {
    /** Guard 入口文件 index.js。 */
    entry: string;
    /** 核心加载器文件所在目录；插件路径相对它解析。 */
    loaderDirectory: string;
    /** 把主人命令交给宿主。 */
    command: (command: GuardCommand) => void;
    /** 交给受限脚本分派，已处理时返回 true。 */
    dispatch: (event: Row) => Promise<boolean>;
}
/**
 * 接管 Guard 自有插件：核心加载 Guard 入口时换成运行时子类，监控与策略不再统计它。
 * 主人命令在 dealEvent 算出 e.msg 与 e.isMaster 后立即处理并结束分派，
 * 先于上下文、仅响应 @、分派前钩子与全部插件；只有黑白名单与冷却仍在其前。
 * 子类以最高优先级在 accept 中分派受限脚本；命令能力只留在本模块闭包内。
 */
export declare function attachGuardPlugin(hooks: LoaderHooks, options: GuardPluginOptions): void;
export {};
