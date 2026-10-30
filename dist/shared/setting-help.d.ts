/** 配置字段说明：控制台展示与 settings.yaml / settings.default.yaml 的注释共用。 */
export interface SettingHelp {
    description: string;
    default?: string;
    change?: string;
}
export declare const settingHelp: Record<string, SettingHelp>;
/** 返回配置路径对应的说明。 */
export declare function helpForPath(path: string[]): SettingHelp | undefined;
