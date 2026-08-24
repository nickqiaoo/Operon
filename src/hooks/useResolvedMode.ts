import { useEffect, useState } from "react"
import { useThemeStore } from "@/stores/theme-store"

/**
 * Reactive resolved theme mode ("light" | "dark"), accounting for the "system"
 * setting and live OS preference changes.
 *
 * Use this to drive `color-scheme` on shadow-DOM widgets (e.g. Pierre trees)
 * whose `light-dark()` colors otherwise follow the OS scheme instead of our
 * forced `.dark` class.
 *
 * Kept out of `theme-store.ts` on purpose: that module must stay a plain
 * zustand store (no React hooks), or Vite's Fast Refresh re-evaluates it on
 * edit and re-creates the store instance, detaching existing subscribers.
 */
export function useResolvedMode(): "light" | "dark" {
  const theme = useThemeStore((s) => s.theme)
  const [systemDark, setSystemDark] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
  )

  useEffect(() => {
    if (typeof window === "undefined") return
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => setSystemDark(mq.matches)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])

  if (theme === "system") return systemDark ? "dark" : "light"
  return theme
}
