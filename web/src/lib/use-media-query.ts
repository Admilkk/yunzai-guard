import { useCallback, useSyncExternalStore } from "react"

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (typeof matchMedia !== "function") return () => {}
      const media = matchMedia(query)
      media.addEventListener("change", listener)
      return () => media.removeEventListener("change", listener)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => (typeof matchMedia === "function" ? matchMedia(query).matches : false),
    () => false,
  )
}
