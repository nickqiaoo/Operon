import { create } from "zustand"
import { persist } from "zustand/middleware"

interface FilePreviewDiffStore {
  /**
   * Mark changed lines in the preview. Off = every file reads plain; the tree's
   * git badges stay either way (they say which files changed, not how).
   */
  enabled: boolean
  /** Comparison base per workspace root; absent = the repo's default base. */
  baseByRoot: Record<string, string>
  setEnabled: (enabled: boolean) => void
  setBase: (rootPath: string, base: string) => void
}

/**
 * Settings for the desktop file preview's git comparison, shared by every open
 * file so switching files keeps the same view.
 */
export const useFilePreviewDiffStore = create<FilePreviewDiffStore>()(
  persist(
    (set) => ({
      enabled: true,
      baseByRoot: {},
      setEnabled: (enabled) => set({ enabled }),
      setBase: (rootPath, base) =>
        set((s) => ({ baseByRoot: { ...s.baseByRoot, [rootPath]: base } })),
    }),
    { name: "operon-file-preview-diff" }
  )
)
