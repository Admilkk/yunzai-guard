/** 管理命令不读取待生效的配置，配置写坏时仍可停止或恢复现有宿主。 */
export declare function request(command: string): Promise<unknown>;
