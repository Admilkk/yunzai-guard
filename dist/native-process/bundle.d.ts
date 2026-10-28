import type { NativeIdentityOptions } from "./protocol.js";
export { hashFile } from "../shared/hash.js";
/** 定位并校验当前平台的原生身份辅助程序。 */
export declare function resolveBundle(options: NativeIdentityOptions): {
    root: string;
    executable: string;
};
