import { create } from "zustand"
import { persist } from "zustand/middleware"
import {
  DEFAULT_DARK_TERMINAL_THEME,
  DEFAULT_LIGHT_TERMINAL_THEME,
} from "@/lib/terminal-themes"

interface TerminalThemeStore {
  /** Terminal theme id used while the app is in light mode. */
  lightTheme: string
  /** Terminal theme id used while the app is in dark mode. */
  darkTheme: string
  setLightTheme: (id: string) => void
  setDarkTheme: (id: string) => void
}

export const useTerminalThemeStore = create<TerminalThemeStore>()(
  persist(
    (set) => ({
      lightTheme: DEFAULT_LIGHT_TERMINAL_THEME,
      darkTheme: DEFAULT_DARK_TERMINAL_THEME,
      setLightTheme: (lightTheme) => set({ lightTheme }),
      setDarkTheme: (darkTheme) => set({ darkTheme }),
    }),
    {
      name: "operon-terminal-theme",
    },
  ),
)
