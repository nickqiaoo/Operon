import { useEffect } from "react"
import { create } from "zustand"
import { persist } from "zustand/middleware"
import { DEFAULT_CODE_FONT, SYSTEM_MONO, codeFontStack } from "@/lib/code-fonts"

interface CodeFontState {
  /** Font family picked in Settings › Appearance (`ui-monospace` = SF Mono). */
  codeFont: string
  setCodeFont: (family: string) => void
}

/** v0 stored a preset id (or "custom" plus a typed name). */
const V0_PRESETS: Record<string, string> = { monaco: "Monaco", "sf-mono": SYSTEM_MONO, menlo: "Menlo" }

export const useCodeFontStore = create<CodeFontState>()(
  persist(
    (set) => ({
      codeFont: DEFAULT_CODE_FONT,
      setCodeFont: (codeFont) => set({ codeFont }),
    }),
    {
      name: "operon-code-font",
      version: 1,
      migrate: (persisted) => {
        const old = (persisted ?? {}) as { codeFont?: unknown }
        const id = typeof old.codeFont === "string" ? old.codeFont : ""
        return { codeFont: V0_PRESETS[id] ?? DEFAULT_CODE_FONT } as CodeFontState
      },
    },
  ),
)

/**
 * Publishes the chosen stack as `--font-code` (code / pre / kbd, Pierre diffs)
 * and `--font-mono` (Tailwind's `font-mono`) on <html>. Mounted once in Root.
 * A family this device lacks just falls through to the default stack.
 */
export function useApplyCodeFont() {
  const codeFont = useCodeFontStore((s) => s.codeFont)
  useEffect(() => {
    const root = document.documentElement
    const stack = codeFontStack(codeFont)
    root.style.setProperty("--font-code", stack)
    root.style.setProperty("--font-mono", stack)
  }, [codeFont])
}
