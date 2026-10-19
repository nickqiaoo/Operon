import { create } from "zustand"

interface FileTreeSearchStore {
  /** The file tree's filter per workspace root; absent = no filter. */
  queryByRoot: Record<string, string>
  setQuery: (rootPath: string, query: string) => void
}

/**
 * The file tree's filter, held outside the tree so it survives the window
 * losing focus, the tab being switched away and the pane remounting. Not
 * persisted: a restart starts with the whole tree.
 */
export const useFileTreeSearchStore = create<FileTreeSearchStore>()((set) => ({
  queryByRoot: {},
  setQuery: (rootPath, query) =>
    set((s) => ({ queryByRoot: { ...s.queryByRoot, [rootPath]: query } })),
}))
