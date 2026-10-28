import { useSyncExternalStore } from "react"

export type ThemeMode = "system" | "light" | "dark"
const storageKey = "guard.theme"
const listeners = new Set<() => void>()
const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null

/** 读取本浏览器保存的主题偏好，默认跟随系统。 */
function readMode(): ThemeMode {
  try {
    const value = localStorage.getItem(storageKey)
    return value === "light" || value === "dark" ? value : "system"
  } catch {
    return "system"
  }
}

let mode = readMode()

/** 解析出实际生效的明暗。 */
function resolve(): "light" | "dark" {
  return mode === "system" ? (media?.matches ? "dark" : "light") : mode
}

/** 把当前主题写到根元素，供样式表按属性切换。 */
function apply(): void {
  document.documentElement.dataset.theme = resolve()
  for (const listener of listeners) listener()
}

media?.addEventListener("change", () => {
  if (mode === "system") apply()
})
apply()

/** 切换并保存主题偏好。 */
export function setThemeMode(next: ThemeMode): void {
  mode = next
  try {
    if (next === "system") localStorage.removeItem(storageKey)
    else localStorage.setItem(storageKey, next)
  } catch {
    // 浏览器不允许存储时只在本次生效。
  }
  apply()
}

/** 订阅主题：返回偏好与实际明暗。 */
export function useTheme(): { mode: ThemeMode; dark: boolean } {
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const current = useSyncExternalStore(subscribe, () => `${mode}:${resolve()}`)
  const [preference, resolved] = current.split(":")
  return { mode: preference as ThemeMode, dark: resolved === "dark" }
}
