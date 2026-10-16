import { create } from "zustand"

/**
 * The chat's Session cards: toggled from the window's top bar, drawn by the
 * visible ChatPanel. The bar is app-wide and ChatPanels are one per tab, so the
 * two meet here.
 */
interface SessionPanelState {
  /** Whether the cards are open. App-wide: it carries over when you switch tabs. */
  open: boolean
  /**
   * Which visible chat can show the panel (its tab id), or `null` when the active
   * tab is not a chat or its provider has no session to read out. The top-bar
   * button only shows while this is set.
   */
  owner: string | null
  setOpen: (open: boolean) => void
  toggle: () => void
  claim: (owner: string) => void
  /** Clears the owner only if it is still `owner`, so a tab leaving can't undo the one arriving. */
  release: (owner: string) => void
}

export const useSessionPanelStore = create<SessionPanelState>((set) => ({
  open: false,
  owner: null,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  claim: (owner) => set({ owner }),
  release: (owner) => set((s) => (s.owner === owner ? { owner: null } : s)),
}))
