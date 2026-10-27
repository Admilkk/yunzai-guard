let csrf = ""

export class ApiError extends Error {
  /** 创建带 HTTP 状态码的接口错误。 */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** 设置后续请求使用的 CSRF 令牌。 */
export function setCsrf(value: string): void {
  csrf = value
}

/** 调用面板 API，自动附带 CSRF 并解析 JSON。 */
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  headers.set("Accept", "application/json")
  if (options.body !== undefined) headers.set("Content-Type", "application/json")
  if (options.method && !["GET", "HEAD"].includes(options.method.toUpperCase()) && csrf)
    headers.set("X-Guard-CSRF", csrf)
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" })
  const result = await response.json().catch(() => ({}))
  if (response.status === 401 && !path.startsWith("/api/login"))
    window.dispatchEvent(new Event("guard:unauthorized"))
  if (!response.ok)
    throw new ApiError(response.status, result.error || `请求失败（${response.status}）`)
  return result as T
}

/** 把非空参数拼成查询字符串。 */
export function query(values: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values))
    if (value !== "" && value !== null && value !== undefined) params.set(key, String(value))
  return params.toString()
}
