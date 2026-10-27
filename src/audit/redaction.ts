/** 仅用于持久化脱敏；策略评估必须先收到原始观察记录。 */
export function redactAuditText(text: string): string {
  return text
    .slice(0, 2048)
    .replace(/(?:https?|wss?):\/\/[^\s"<>]+/gi, raw => {
      try {
        const url = new URL(raw)
        // API 凭据可能位于路径片段中，例如 /bot<TOKEN>/sendMessage。
        // 仅保留来源地址，也能避免泄露用户控制的资源名称。
        return url.origin + (url.pathname === "/" ? "/" : "/[path-redacted]")
      } catch {
        return "[invalid URL]"
      }
    })
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(
      /((?:token|password|passwd|secret|authorization|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    )
}
