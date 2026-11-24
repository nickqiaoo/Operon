import { create } from "zustand"
import type { PendingInputSummary } from "@shared/pending-input"
import { chatKey, replaceNodeEntries, type ChatKey, type ChatRef, type NodeKey } from "@/lib/chat-ref"

/**
 * What each conversation is waiting on a person for, mirrored from the
 * live-status stream (see `watchPendingInput` in lib/live-turn-events.ts). A chat
 * absent from the map has nothing pending. Keyed by `ChatKey`: each machine
 * whose stream is open reports its own chats.
 */
export const useChatPendingInputStore = create<{
  pendingByChat: ReadonlyMap<ChatKey, PendingInputSummary[]>
  /** One machine's full list (its stream's `sync` frame). */
  sync: (node: NodeKey, chats: Array<{ chatId: number; pending: PendingInputSummary[] }>) => void
  set: (chat: ChatRef, pending: PendingInputSummary[]) => void
}>((set) => ({
  pendingByChat: new Map(),
  sync: (node, chats) =>
    set((state) => ({
      pendingByChat: replaceNodeEntries(
        state.pendingByChat,
        node,
        chats.filter((chat) => chat.pending.length > 0).map((chat): [number, PendingInputSummary[]] => [chat.chatId, chat.pending]),
      ),
    })),
  set: (chat, pending) =>
    set((state) => {
      const key = chatKey(chat)
      if (pending.length === 0 && !state.pendingByChat.has(key)) return state
      const next = new Map(state.pendingByChat)
      if (pending.length > 0) next.set(key, pending)
      else next.delete(key)
      return { pendingByChat: next }
    }),
}))
