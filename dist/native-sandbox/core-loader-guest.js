import { refuse } from "../protect/objects.js";
// ESM 活绑定仅存在于本插件进程，不导入宿主加载器对象。
let facade = Object.freeze({});
let api = Object.freeze({});
let loaderInstalled = false;
let apiInstalled = false;
/** 安装沙箱内的核心加载器外观。 */
export function installNativeCoreLoaderFacade(value) {
    if (loaderInstalled)
        refuse("runtime-reinstall", "native-core-loader");
    loaderInstalled = true;
    facade = value;
}
/** 安装沙箱内的核心 API 副本。 */
export function installNativeCoreApi(value) {
    if (apiInstalled)
        refuse("runtime-reinstall", "native-core-api");
    apiInstalled = true;
    api = Object.freeze({ ...value });
}
/** 返回已安装的核心 API 副本。 */
export function nativeCoreApi() {
    return api;
}
export { facade as default };
//# sourceMappingURL=core-loader-guest.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("native-sandbox/core-loader-guest.ts", { installNativeCoreLoaderFacade, installNativeCoreApi, nativeCoreApi, facade })
