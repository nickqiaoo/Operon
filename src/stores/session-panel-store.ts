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
  /**
   * True when the right panel auto-closed us and we owe the user a restore. Set
   * only by `suspendForRightPanel`; any explicit open/close clears it, so a panel
   * the user dismissed by hand while the right panel was up stays dismissed.
   * Transient — this store is not persisted.
   */
  autoClosed: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
  claim: (owner: string) => void
  /** Clears the owner only if it is still `owner`, so a tab leaving can't undo the one arriving. */
  release: (owner: string) => void
  /** The right panel is opening: close us, but remember whether we were open. */
  suspendForRightPanel: () => void
  /** The right panel is closing: bring us back only if it was the one that hid us. */
  restoreAfterRightPanel: () => void
}

export const useSessionPanelStore = create<SessionPanelState>((set) => ({
  open: false,
  owner: null,
  autoClosed: false,
  setOpen: (open) => set({ open, autoClosed: false }),
  toggle: () => set((s) => ({ open: !s.open, autoClosed: false })),
  claim: (owner) => set({ owner }),
  release: (owner) => set((s) => (s.owner === owner ? { owner: null } : s)),
  suspendForRightPanel: () => set((s) => ({ open: false, autoClosed: s.open })),
  restoreAfterRightPanel: () =>
    set((s) => (s.autoClosed ? { open: true, autoClosed: false } : {})),
}))
