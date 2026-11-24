import { create } from "zustand"
import { chatKey, replaceNodeEntries, type ChatKey, type ChatRef, type NodeKey } from "@/lib/chat-ref"

/**
 * Chats the server reports as running a turn right now, mirrored from the
 * live-status stream (see `lib/live-turn-events.ts`). Unlike the streaming
 * store, which only knows the chat panels that are mounted, this covers every
 * chat — a lead woken in another workspace, a turn started from the phone.
 *
 * Keyed by `ChatKey`: each machine whose stream is open reports its own chats.
 */
export const useChatPresenceStore = create<{
  runningChats: ReadonlySet<ChatKey>
  /** One machine's full list (its stream's `sync` frame). */
  sync: (node: NodeKey, chatIds: Iterable<number>) => void
  set: (chat: ChatRef, running: boolean) => void
}>((set) => ({
  runningChats: new Set(),
  sync: (node, chatIds) =>
    set((state) => {
      const entries = [...chatIds].map((chatId): [number, true] => [chatId, true])
      const map = new Map([...state.runningChats].map((key): [ChatKey, true] => [key, true]))
      return { runningChats: new Set(replaceNodeEntries(map, node, entries).keys()) }
    }),
  set: (chat, running) =>
    set((state) => {
      const key = chatKey(chat)
      if (state.runningChats.has(key) === running) return state
      const next = new Set(state.runningChats)
      if (running) next.add(key)
      else next.delete(key)
      return { runningChats: next }
    }),
}))

