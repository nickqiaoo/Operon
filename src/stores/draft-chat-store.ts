import { create } from "zustand"

/**
 * Where a not-yet-sent chat will run, beyond the workspace it sits in: whether
 * its first send should cut a new worktree, and from which branch. Nothing is
 * created until that send, so a draft that is never sent leaves nothing behind.
 */
export interface DraftWorktreeIntent {
  newWorktree: boolean
  /** The branch a new worktree starts from; null = what is checked out now. */
  baseBranch: string | null
  /** The worktree is being created for the first send. */
  creating: boolean
}

const EMPTY: DraftWorktreeIntent = { newWorktree: false, baseBranch: null, creating: false }

interface DraftChatState {
  byTab: Record<string, DraftWorktreeIntent>
  setNewWorktree: (tabId: string, on: boolean) => void
  setBaseBranch: (tabId: string, branch: string | null) => void
  setCreating: (tabId: string, creating: boolean) => void
  clear: (tabId: string) => void
}

export const useDraftChatStore = create<DraftChatState>((set) => {
  const patch = (tabId: string, next: Partial<DraftWorktreeIntent>) =>
    set((state) => ({ byTab: { ...state.byTab, [tabId]: { ...(state.byTab[tabId] ?? EMPTY), ...next } } }))
  return {
    byTab: {},
    setNewWorktree: (tabId, on) => patch(tabId, { newWorktree: on }),
    setBaseBranch: (tabId, branch) => patch(tabId, { baseBranch: branch }),
    setCreating: (tabId, creating) => patch(tabId, { creating }),
    clear: (tabId) =>
      set((state) => {
        if (!(tabId in state.byTab)) return state
        const { [tabId]: _removed, ...rest } = state.byTab
        return { byTab: rest }
      }),
  }
})

export function draftWorktreeIntent(tabId: string): DraftWorktreeIntent {
  return useDraftChatStore.getState().byTab[tabId] ?? EMPTY
}
