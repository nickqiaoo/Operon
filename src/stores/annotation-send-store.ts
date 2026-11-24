import { create } from "zustand"

/**
 * One-shot bridge so the browser annotation toolbar's "send" can trigger the
 * workspace's focused chat to submit (folding in the queued annotations). The
 * browser bumps `nonce` for a workspace; the focused `ChatPanel` for that
 * workspace observes the change and calls its submit, then clears the request.
 */
interface AnnotationSendState {
  workspaceId: number | null
  /** Machine of that workspace; null for this one. */
  nodeId: string | null
  nonce: number
  requestSend: (workspaceId: number | null, nodeId: string | null) => void
  consume: () => void
}

export const useAnnotationSendStore = create<AnnotationSendState>((set) => ({
  workspaceId: null,
  nodeId: null,
  nonce: 0,
  requestSend: (workspaceId, nodeId) => set((s) => ({ workspaceId, nodeId, nonce: s.nonce + 1 })),
  consume: () => set({ workspaceId: null, nodeId: null, nonce: 0 }),
}))
