/**
 * 把控制台输入按行切开，超长的行再按 JSON 编码后的字节数分段，不拆开代理对，
 * 确保每个 input 请求都在控制端点的大小上限内。
 */
export declare function splitInput(text: string): string[];
/**
 * 管理命令不读取待生效的配置，配置写坏时仍可停止或恢复现有宿主。
 * extra 为命令附带的字段，例如 input 的 data；读不到控制信息时返回被拒绝的 Promise。
 */
export declare function request(command: string, extra?: Record<string, unknown>): Promise<unknown>;
