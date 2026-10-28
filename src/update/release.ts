import { M } from "../shared/messages.js"
import { compareVersions, parseVersion } from "../shared/version.js"

export const repository = "Admilkk/yunzai-guard"
const downloadPrefix = `https://github.com/${repository}/releases/download/`
const maxReleaseBytes = 1024 * 1024
const requestTimeoutMs = 20000

export interface ReleaseAsset {
  name: string
  url: string
  size: number
}

export interface ReleaseInfo {
  tag: string
  version: string
  name: string
  notes: string
  url: string
  publishedAt: string
  assets: ReleaseAsset[]
}

export interface LatestResult {
  /** 条件请求命中缓存时为空，调用方沿用上一次的发布信息。 */
  release?: ReleaseInfo
  etag?: string
}

/** 构造请求头；发布信息是公开数据，不携带任何凭据。 */
export function requestHeaders(version: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": `yunzai-guard/${version}`,
    "X-GitHub-Api-Version": "2022-11-28",
  }
}

/** 分块读取发布元数据，达到字节上限时立即取消响应，避免先缓冲完整正文。 */
async function limitedText(response: Response, limit: number): Promise<string> {
  const length = Number(response.headers.get("content-length"))
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel().catch(() => {})
    throw new Error(M.update.tooLarge)
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks, size).toString("utf8")
      size += value.byteLength
      if (size > limit) throw new Error(M.update.tooLarge)
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** 校验并规整 GitHub 发布信息，只接受本仓库的下载地址。 */
export function parseRelease(value: unknown): ReleaseInfo {
  const source = value as Record<string, unknown> | null
  if (!source || typeof source !== "object" || Array.isArray(source))
    throw new Error(M.update.badRelease)
  const tag = source.tag_name
  if (typeof tag !== "string" || !parseVersion(tag) || source.draft === true)
    throw new Error(M.update.badRelease)
  const assets = Array.isArray(source.assets) ? source.assets : []
  return {
    tag,
    version: tag.replace(/^v/, ""),
    name: typeof source.name === "string" ? source.name.slice(0, 120) : tag,
    notes: typeof source.body === "string" ? source.body.slice(0, 4000) : "",
    url:
      typeof source.html_url === "string" && source.html_url.startsWith("https://github.com/")
        ? source.html_url
        : `https://github.com/${repository}/releases/tag/${tag}`,
    publishedAt: typeof source.published_at === "string" ? source.published_at : "",
    assets: assets.flatMap((item: unknown) => {
      const asset = item as Record<string, unknown> | null
      const url = asset?.browser_download_url
      if (
        !asset ||
        typeof asset.name !== "string" ||
        typeof url !== "string" ||
        !url.startsWith(downloadPrefix) ||
        typeof asset.size !== "number"
      )
        return []
      return [{ name: asset.name, url, size: asset.size }]
    }),
  }
}

/** 经 API 请求最新正式发布；带上一次的 ETag 时，未变化的响应不占用 GitHub 速率限制。 */
async function fetchViaApi(version: string, etag?: string): Promise<LatestResult> {
  let response: Response
  try {
    response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { ...requestHeaders(version), ...(etag ? { "If-None-Match": etag } : {}) },
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
  } catch (error) {
    throw new Error(M.update.fetchFailed((error as Error).message))
  }
  if (response.status === 304) return { etag }
  if (!response.ok)
    throw new Error(
      M.update.fetchFailed(
        response.headers.get("x-ratelimit-remaining") === "0"
          ? "GitHub API 访问次数已用尽"
          : `HTTP ${response.status}`,
      ),
    )
  try {
    const release = parseRelease(JSON.parse(await limitedText(response, maxReleaseBytes)))
    return { release, etag: response.headers.get("etag") ?? undefined }
  } catch (error) {
    throw new Error(M.update.fetchFailed((error as Error).message))
  }
}

/**
 * 不经 API 的后备：读取 releases/latest 的跳转地址得到标签，资产地址按发布约定推出。
 * 共享出口 IP 常耗尽匿名 API 额度，此路径不受该额度影响，但没有更新说明与文件大小。
 */
async function fetchViaRedirect(version: string): Promise<LatestResult> {
  const response = await fetch(`https://github.com/${repository}/releases/latest`, {
    headers: { "User-Agent": `yunzai-guard/${version}` },
    redirect: "manual",
    signal: AbortSignal.timeout(requestTimeoutMs),
  })
  const match = /\/releases\/tag\/([^/?#]+)$/.exec(response.headers.get("location") ?? "")
  const tag = match && decodeURIComponent(match[1]!)
  if (!tag || !parseVersion(tag)) throw new Error(M.update.badRelease)
  const base = `${downloadPrefix}${encodeURIComponent(tag)}/`
  const names = [
    `yunzai-guard-${tag}-win-x64.zip`,
    `yunzai-guard-${tag}-linux-x64.tar.gz`,
    `yunzai-guard-${tag}-macos.tar.gz`,
    "SHA256SUMS.txt",
  ]
  return {
    release: {
      tag,
      version: tag.replace(/^v/, ""),
      name: tag,
      notes: "",
      url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`,
      publishedAt: "",
      assets: names.map(name => ({ name, url: base + name, size: 0 })),
    },
  }
}

/** 请求最新正式发布；API 不可用时改用跳转地址。 */
export async function fetchLatestRelease(version: string, etag?: string): Promise<LatestResult> {
  try {
    return await fetchViaApi(version, etag)
  } catch (error) {
    try {
      return await fetchViaRedirect(version)
    } catch {
      throw error
    }
  }
}

/** 判断发布是否比当前版本新；无法比较时视为不新。 */
export function isNewer(release: string, current: string): boolean {
  return (compareVersions(release, current) ?? 0) > 0
}

/** 判断两个版本的主版本号是否不同。 */
export function crossesMajor(release: string, current: string): boolean {
  return parseVersion(release)?.core[0] !== parseVersion(current)?.core[0]
}
