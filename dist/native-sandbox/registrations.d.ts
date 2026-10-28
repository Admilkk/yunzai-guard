import type { NativeClassDescriptor } from "./types.js";
/** 跨文件和元数据更新累计限制宿主调度及 Handler 分配，不只限制单帧。 */
export declare class NativeRegistrationBudget {
    private readonly plugins;
    /** 检查注册是否冲突。 */
    private check;
    /** 预留插件文件的类注册。 */
    reserve(id: string, file: string, descriptors: NativeClassDescriptor[]): void;
    /** 更新一个类注册。 */
    update(id: string, file: string, raw: NativeClassDescriptor): void;
    /** 释放插件或单个文件的注册。 */
    release(id: string, file?: string): void;
}
