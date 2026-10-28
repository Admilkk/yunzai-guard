import type { NativeRedisPermissions } from "./types.js";
/** DTO 复制和 JSON 编码前拒绝超大结果；此时 Redis 客户端已接收到数据。 */
export declare function validateNativeRedisResult(value: unknown): void;
/** 准备使用原键名的单条命令，执行宿主命令前检查全部键。 */
export declare function prepareNativeRedisCommand(permissions: NativeRedisPermissions | undefined, method: string, input: unknown[]): {
    method: string;
    args: unknown[];
};
/** 执行沙箱请求的 Redis 命令，只允许授权键与命令。 */
export declare function executeNativeRedis(target: unknown, permissions: NativeRedisPermissions | undefined, method: string, args: unknown[]): Promise<unknown>;
