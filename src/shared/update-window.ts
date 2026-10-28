/** 解析维护时段 "HH:MM-HH:MM"，返回当天起止分钟；格式不符返回 undefined。起止相同视为全天。 */
export function parseWindow(text: string): { start: number; end: number } | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(text)
  if (!match) return undefined
  return {
    start: Number(match[1]) * 60 + Number(match[2]),
    end: Number(match[3]) * 60 + Number(match[4]),
  }
}

/** 判断本地时间是否落在维护时段内，支持跨午夜（如 23:00-02:00）。 */
export function inWindow(text: string, date: Date): boolean {
  const window = parseWindow(text)
  if (!window) return false
  if (window.start === window.end) return true
  const minute = date.getHours() * 60 + date.getMinutes()
  return window.start < window.end
    ? minute >= window.start && minute < window.end
    : minute >= window.start || minute < window.end
}
