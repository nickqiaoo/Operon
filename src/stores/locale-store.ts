import { create } from "zustand"
import { persist } from "zustand/middleware"

/** Languages we ship a catalog for. English is the source language (no catalog). */
export type Locale = "en" | "zh-CN"
/** User preference: an explicit locale, or "system" (follow the OS/browser). */
export type LocalePref = "system" | Locale

interface LocaleStore {
  /** Persisted user choice. "system" resolves against navigator.language. */
  localeOverride: LocalePref
  setLocale: (pref: LocalePref) => void
}

export const useLocaleStore = create<LocaleStore>()(
  persist(
    (set) => ({
      localeOverride: "system",
      setLocale: (localeOverride) => set({ localeOverride }),
    }),
    { name: "operon-locale" }
  )
)

/** Resolve a preference to a concrete catalog locale. */
export function resolveLocale(pref: LocalePref): Locale {
  if (pref !== "system") return pref
  const sys = typeof navigator !== "undefined" ? navigator.language?.toLowerCase() ?? "" : ""
  return sys.startsWith("zh") ? "zh-CN" : "en"
}

/** Options for the language picker (kept here so new locales are added in one place). */
export const LOCALE_OPTIONS: { id: LocalePref; label: string }[] = [
  { id: "system", label: "System" },
  { id: "en", label: "English" },
  { id: "zh-CN", label: "简体中文" },
]
