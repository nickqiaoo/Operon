import { memo, useEffect } from "react"
import { Toaster } from "sonner"
import { useThemeStore, applyTheme } from "@/stores/theme-store"

/**
 * Applies the theme to the document and renders the toaster that follows it.
 * A component of its own so a theme change does not re-render the whole shell.
 */
export const ThemeHost = memo(function ThemeHost() {
  const theme = useThemeStore((state) => state.theme)
  const lightUITheme = useThemeStore((state) => state.lightUITheme)
  const darkUITheme = useThemeStore((state) => state.darkUITheme)

  // Apply theme on mount and when theme or UI preset changes
  useEffect(() => {
    applyTheme(theme)

    // Listen for system theme changes
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
    const handleChange = () => {
      if (theme === "system") {
        applyTheme("system")
      }
    }
    mediaQuery.addEventListener("change", handleChange)
    return () => mediaQuery.removeEventListener("change", handleChange)
  }, [theme, lightUITheme, darkUITheme])

  return <Toaster position="bottom-right" closeButton theme={theme} />
})
