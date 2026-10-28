/** 面板是宿主进程的附加入口：配置放在 Guard 状态目录，业务插件无法读写。 */
export interface PanelSettings {
    enabled: boolean;
    host: string;
    port: number;
    tokenTtlHours: number;
    trustedDeviceTtlDays: number;
    trustProxy: boolean;
    jwtSecret: string;
}
/** 返回面板配置文件路径。 */
export declare function panelSettingsPath(stateDir: string): string;
/** 生成随机密钥。 */
export declare function randomSecret(): string;
/** 生成指定长度的数字验证码。 */
export declare function randomCode(length: number): string;
/** 字段损坏时回落到默认值并立即规范化落盘，避免面板因手改配置而无法启动。 */
export declare function loadPanelSettings(stateDir: string): PanelSettings;
export interface PanelSettingsPatch {
    host?: string;
    port?: number;
    tokenTtlHours?: number;
    trustedDeviceTtlDays?: number;
    enabled?: boolean;
}
/** 保留 secret，只覆盖面板可调项；非法值直接拒绝。 */
export declare function savePanelSettings(stateDir: string, patch: PanelSettingsPatch): PanelSettings;
