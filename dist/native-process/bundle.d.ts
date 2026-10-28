import type { NativeIdentityOptions } from "./protocol.js";
/** 计算文件的 SHA-256 摘要。 */
export declare function hashFile(file: string): string;
/** 定位并校验当前平台的原生身份辅助程序。 */
export declare function resolveBundle(options: NativeIdentityOptions): {
    root: string;
    executable: string;
};
