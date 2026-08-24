import { create } from "zustand"

/**
 * One-shot bridge so the browser annotation toolbar's "send" can trigger the
 * workspace's focused chat to submit (folding in the queued annotations). The
 * browser bumps `nonce` for a workspace; the focused `ChatPanel` for that
 * workspace observes the change and calls its submit, then clears the request.
 */
interface AnnotationSendState {
  workspaceId: number | null
  nonce: number
  requestSend: (workspaceId: number | null) => void
  consume: () => void
}

export const useAnnotationSendStore = create<AnnotationSendState>((set) => ({
  workspaceId: null,
  nonce: 0,
  requestSend: (workspaceId) => set((s) => ({ workspaceId, nonce: s.nonce + 1 })),
  consume: () => set({ workspaceId: null }),
}))
