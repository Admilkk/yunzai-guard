/** 判断 `X.Y.Z` 正式版本号是否不低于下限；其他格式一律视为不满足。 */
export declare function atLeastVersion(value: unknown, minimum: readonly [number, number, number]): boolean;
/** 解析 `X.Y.Z[-预发布]` 版本号；其他格式返回 undefined。 */
export declare function parseVersion(value: unknown): {
    core: [number, number, number];
    pre: string[];
} | undefined;
/** 按语义化版本比较，返回正数表示 a 更新；任一版本无法解析时返回 undefined。 */
export declare function compareVersions(a: unknown, b: unknown): number | undefined;
