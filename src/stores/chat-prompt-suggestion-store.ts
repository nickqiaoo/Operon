import { create } from "zustand"
import { chatKey, replaceNodeEntries, type ChatKey, type ChatRef, type NodeKey } from "@/lib/chat-ref"

/**
 * Each conversation's next-prompt guess from Claude Code, mirrored from the
 * live-status stream (see lib/live-turn-events.ts). The server clears a chat's
 * entry as soon as its next turn starts. Keyed by `ChatKey`: each machine whose
 * stream is open reports its own chats.
 */
export const useChatPromptSuggestionStore = create<{
  suggestionByChat: ReadonlyMap<ChatKey, string>
  /** One machine's full list (its stream's `sync` frame). */
  sync: (node: NodeKey, chats: Array<{ chatId: number; text: string }>) => void
  set: (chat: ChatRef, text: string | null) => void
}>((set) => ({
  suggestionByChat: new Map(),
  sync: (node, chats) =>
    set((state) => ({
      suggestionByChat: replaceNodeEntries(state.suggestionByChat, node, chats.map((chat): [number, string] => [chat.chatId, chat.text])),
    })),
  set: (chat, text) =>
    set((state) => {
      const key = chatKey(chat)
      if (text === null && !state.suggestionByChat.has(key)) return state
      if (text !== null && state.suggestionByChat.get(key) === text) return state
      const next = new Map(state.suggestionByChat)
      if (text === null) next.delete(key)
      else next.set(key, text)
      return { suggestionByChat: next }
    }),
}))

/** The chat's current guess at what the user will type next, if any. */
export function useChatPromptSuggestion(chat: ChatRef | undefined): string | null {
  const key = chat ? chatKey(chat) : undefined
  return useChatPromptSuggestionStore((state) => (key == null ? null : state.suggestionByChat.get(key) ?? null))
}
