type EventRecord = Record<string, unknown>;
/** 仅在最终插件事件对象上重建 DTO 标记的核心游戏标志。 */
export declare function restoreNativeEventFlags<T extends EventRecord>(record: T): T;
export {};
