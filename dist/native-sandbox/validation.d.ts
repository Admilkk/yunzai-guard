import type { NativeClassDescriptor } from "./types.js";
/** 仅校验核心会解释的数据，插件代码、正则和回调不进入宿主。 */
export declare function validateNativeDescriptor(value: unknown): NativeClassDescriptor;
/** 适配器可为媒体消息读取文件或 URL，但不能将这些来源转成宿主权限。 */
export declare function validateReplyArguments(args: unknown[]): [unknown, boolean, Record<string, never>];
