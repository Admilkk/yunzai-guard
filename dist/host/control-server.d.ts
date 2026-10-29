import net from "node:net";
export declare const controlCommands: readonly ["status", "restart", "stop", "resume", "invoke-bot-restart", "check-update", "update", "force-update", "rollback", "input"];
export type ControlCommand = (typeof controlCommands)[number];
interface ControlServerOptions {
    /** 每代宿主随机生成的令牌，只写入 0600 的 control.json。 */
    token: string;
    /** 认证通过后执行命令，返回值作为应答；message 为完整请求，供 input 读取附带的 data。 */
    handle: (command: ControlCommand, message: Record<string, unknown>) => unknown;
    /** 应答发出后再执行的动作，例如 stop。 */
    after?: (command: ControlCommand) => void;
}
export declare const maxRequestBytes = 16384;
/**
 * 本机 CLI 控制端点：单行 JSON 请求，常量时间比较令牌。
 * 任何格式、认证或命令错误都直接断开，不回传原因。
 */
export declare function createControlServer({ token, handle, after }: ControlServerOptions): net.Server;
export {};
