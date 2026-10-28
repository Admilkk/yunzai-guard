export interface NativePriorityTag {
    $type: "NativePriority";
    value: "positive-infinity" | "negative-infinity";
}
/** Infinity 可用于加载器排序元数据，不能作为普通 JSON 数字。 */
export declare function encodeNativePriority(value: unknown): number | NativePriorityTag;
/** 解析插件优先级。 */
export declare function parseNativePriority(value: unknown): number;
