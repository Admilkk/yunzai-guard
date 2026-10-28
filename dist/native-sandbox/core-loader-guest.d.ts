declare let facade: object;
/** 安装沙箱内的核心加载器外观。 */
export declare function installNativeCoreLoaderFacade(value: object): void;
/** 安装沙箱内的核心 API 副本。 */
export declare function installNativeCoreApi(value: Record<string, unknown>): void;
/** 返回已安装的核心 API 副本。 */
export declare function nativeCoreApi(): Readonly<Record<string, unknown>>;
export { facade as default };
