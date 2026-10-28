import type { CoreBot } from "../../shared/types.js";
import { type ExitHookSource } from "./exit-hooks.js";
/** 退出前关闭原始或受控核心资源，绝不停止外部 Redis。 */
export declare function shutdownBootstrapResources(bot: ExitHookSource & Pick<CoreBot, "redisExit">, redisClient: unknown, timeout: number, currentRedisClient?: () => unknown): Promise<void>;
