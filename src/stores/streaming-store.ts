import { create } from "zustand"

interface StreamingStore {
  /** Tab IDs currently generating */
  streamingTabIds: Set<string>
  /** Tab IDs that finished generating but user hasn't visited the workspace yet */
  unseenTabIds: Set<string>
  setStreaming: (tabId: string, isStreaming: boolean) => void
  /** Clear unseen tabs for a set of tab IDs (called when user visits a workspace) */
  clearUnseen: (tabIds: string[]) => void
}

export const useStreamingStore = create<StreamingStore>()((set) => ({
  streamingTabIds: new Set(),
  unseenTabIds: new Set(),

  setStreaming: (tabId, isStreaming) =>
    set((state) => {
      const nextStreaming = new Set(state.streamingTabIds)
      const nextUnseen = new Set(state.unseenTabIds)

      if (isStreaming) {
        if (nextStreaming.has(tabId)) return state
        nextStreaming.add(tabId)
        // If it starts streaming again, remove from unseen
        nextUnseen.delete(tabId)
      } else {
        if (!nextStreaming.has(tabId)) return state
        nextStreaming.delete(tabId)
        // Finished generating → mark as unseen
        nextUnseen.add(tabId)
      }

      return { streamingTabIds: nextStreaming, unseenTabIds: nextUnseen }
    }),

  clearUnseen: (tabIds) =>
    set((state) => {
      let changed = false
      const next = new Set(state.unseenTabIds)
      for (const id of tabIds) {
        if (next.has(id)) {
          next.delete(id)
          changed = true
        }
      }
      return changed ? { unseenTabIds: next } : state
    }),
}))
