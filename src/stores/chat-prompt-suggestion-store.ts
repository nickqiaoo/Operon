import { create } from "zustand"

/**
 * Each conversation's next-prompt guess from Claude Code, mirrored from the
 * live-status stream (see lib/live-turn-events.ts). The server clears a chat's
 * entry as soon as its next turn starts.
 */
export const useChatPromptSuggestionStore = create<{
  suggestionByChat: ReadonlyMap<number, string>
  sync: (chats: Array<{ chatId: number; text: string }>) => void
  set: (chatId: number, text: string | null) => void
}>((set) => ({
  suggestionByChat: new Map(),
  sync: (chats) => set({ suggestionByChat: new Map(chats.map((chat) => [chat.chatId, chat.text])) }),
  set: (chatId, text) =>
    set((state) => {
      if (text === null && !state.suggestionByChat.has(chatId)) return state
      if (text !== null && state.suggestionByChat.get(chatId) === text) return state
      const next = new Map(state.suggestionByChat)
      if (text === null) next.delete(chatId)
      else next.set(chatId, text)
      return { suggestionByChat: next }
    }),
}))

/** The chat's current guess at what the user will type next, if any. */
export function useChatPromptSuggestion(chatId: number | undefined): string | null {
  return useChatPromptSuggestionStore((state) => (chatId == null ? null : state.suggestionByChat.get(chatId) ?? null))
}
