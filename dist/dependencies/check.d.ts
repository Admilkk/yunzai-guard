import type { GuardSettings } from "../shared/types.js";
/** 只准备当前模式确实需要的组件，不安装系统服务或提升权限。 */
export declare function prepareDependencies(settings: GuardSettings): Promise<Record<string, unknown>>;
