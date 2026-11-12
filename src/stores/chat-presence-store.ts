import { create } from "zustand"

/**
 * Chats the server reports as running a turn right now, mirrored from the
 * live-status stream (see `lib/live-turn-events.ts`). Unlike the streaming
 * store, which only knows the chat panels that are mounted, this covers every
 * chat — a lead woken in another workspace, a turn started from the phone.
 */
export const useChatPresenceStore = create<{
  runningChatIds: ReadonlySet<number>
  sync: (chatIds: Iterable<number>) => void
  set: (chatId: number, running: boolean) => void
}>((set) => ({
  runningChatIds: new Set(),
  sync: (chatIds) => set({ runningChatIds: new Set(chatIds) }),
  set: (chatId, running) =>
    set((state) => {
      if (state.runningChatIds.has(chatId) === running) return state
      const next = new Set(state.runningChatIds)
      if (running) next.add(chatId)
      else next.delete(chatId)
      return { runningChatIds: next }
    }),
}))
