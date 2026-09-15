import { create } from "zustand"
import type { PendingInputSummary } from "@shared/pending-input"

/**
 * What each conversation is waiting on a person for, mirrored from the
 * live-status stream (see `watchPendingInput` in lib/live-turn-events.ts). A chat
 * absent from the map has nothing pending.
 */
export const useChatPendingInputStore = create<{
  pendingByChat: ReadonlyMap<number, PendingInputSummary[]>
  sync: (chats: Array<{ chatId: number; pending: PendingInputSummary[] }>) => void
  set: (chatId: number, pending: PendingInputSummary[]) => void
}>((set) => ({
  pendingByChat: new Map(),
  sync: (chats) =>
    set({ pendingByChat: new Map(chats.filter((chat) => chat.pending.length > 0).map((chat) => [chat.chatId, chat.pending])) }),
  set: (chatId, pending) =>
    set((state) => {
      if (pending.length === 0 && !state.pendingByChat.has(chatId)) return state
      const next = new Map(state.pendingByChat)
      if (pending.length > 0) next.set(chatId, pending)
      else next.delete(chatId)
      return { pendingByChat: next }
    }),
}))
