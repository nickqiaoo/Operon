import { create } from "zustand"
import { persist } from "zustand/middleware"
import {
  getThemeById,
  applyUIThemeColors,
  clearUIThemeColors,
} from "@/lib/ui-themes"

type Theme = "light" | "dark" | "system"

interface ThemeStore {
  theme: Theme
  /** Selected UI preset for light mode (theme id) */
  lightUITheme: string
  /** Selected UI preset for dark mode (theme id) */
  darkUITheme: string
  setTheme: (theme: Theme) => void
  setLightUITheme: (id: string) => void
  setDarkUITheme: (id: string) => void
}

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set) => ({
      theme: "system",
      lightUITheme: "default-light",
      darkUITheme: "default-dark",
      setTheme: (theme) => set({ theme }),
      setLightUITheme: (lightUITheme) => set({ lightUITheme }),
      setDarkUITheme: (darkUITheme) => set({ darkUITheme }),
    }),
    {
      name: "operon-theme",
    }
  )
)

/** Resolve light or dark from theme + system preference */
function resolveMode(theme: Theme): "light" | "dark" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  }
  return theme
}

/** Apply theme class + UI preset colors */
export function applyTheme(theme: Theme) {
  const root = window.document.documentElement
  root.classList.remove("light", "dark")
  delete root.dataset.codeTheme

  const mode = resolveMode(theme)
  root.classList.add(mode)

  // Apply the matching UI theme preset
  const store = useThemeStore.getState()
  const presetId = mode === "dark" ? store.darkUITheme : store.lightUITheme
  const defaultId = mode === "dark" ? "default-dark" : "default-light"
  const preset = getThemeById(presetId)

  if (preset && presetId !== defaultId) {
    applyUIThemeColors(preset)
  } else {
    // Default → clear overrides, let CSS handle it
    clearUIThemeColors()
  }
}
