export declare const repository = "Admilkk/yunzai-guard";
export interface ReleaseAsset {
    name: string;
    url: string;
    size: number;
}
export interface ReleaseInfo {
    tag: string;
    version: string;
    name: string;
    notes: string;
    url: string;
    publishedAt: string;
    assets: ReleaseAsset[];
}
export interface LatestResult {
    /** 条件请求命中缓存时为空，调用方沿用上一次的发布信息。 */
    release?: ReleaseInfo;
    etag?: string;
}
/** 构造请求头；发布信息是公开数据，不携带任何凭据。 */
export declare function requestHeaders(version: string): Record<string, string>;
/** 校验并规整 GitHub 发布信息，只接受本仓库的下载地址。 */
export declare function parseRelease(value: unknown): ReleaseInfo;
/** 请求最新正式发布；API 不可用时改用跳转地址。 */
export declare function fetchLatestRelease(version: string, etag?: string): Promise<LatestResult>;
/** 判断发布是否比当前版本新；无法比较时视为不新。 */
export declare function isNewer(release: string, current: string): boolean;
/** 判断两个版本的主版本号是否不同。 */
export declare function crossesMajor(release: string, current: string): boolean;
