import { useEffect } from "react"
import { Style, StatusBar } from "@capacitor/status-bar"
import { isNativeApp, nativePlatform } from "@/lib/native"
import { useThemeStore } from "@/stores/theme-store"

/**
 * Keep the iOS status bar legible against whatever the app is currently
 * painting behind it.
 *
 * The web view draws under the status bar (`contentInset: 'never'` plus
 * `viewport-fit=cover`), so the clock and battery sit directly on top of the
 * app's own background — nothing else would make them switch colour with the
 * theme, and dark glyphs on the dark canvas are effectively invisible.
 *
 * No-op outside the packaged app.
 */
export function useNativeStatusBar(): void {
  const theme = useThemeStore((s) => s.theme)

  useEffect(() => {
    if (!isNativeApp()) return

    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches)
      // Style.Dark means "content for a dark background", i.e. light glyphs.
      void StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => {})
    }

    // Draw behind the status bar rather than reserving a band for it; the
    // layout already pads itself with `env(safe-area-inset-top)`.
    void StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {})
    // Android additionally paints a status bar background even when
    // overlaying, and defaults it to opaque. Force it transparent or a solid
    // band sits over the app's own header. Not a thing on iOS.
    if (nativePlatform() === "android") {
      void StatusBar.setBackgroundColor({ color: "#00000000" }).catch(() => {})
    }
    apply()

    media.addEventListener("change", apply)
    return () => media.removeEventListener("change", apply)
  }, [theme])
}
