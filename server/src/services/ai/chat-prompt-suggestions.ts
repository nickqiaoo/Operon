// Each conversation's "what you might type next", as Claude Code last guessed it.
//
// With `promptSuggestions` on, the Claude Code CLI predicts the user's next prompt
// after every turn (not the first one, not in plan mode, not near the usage
// limit). The composer shows it as grey placeholder text that Tab fills in. It
// arrives after the turn's stream has closed (`RuntimeBackgroundEvent`
// `prompt-suggestion`), so it reaches the client over the live-status stream,
// like background tasks.
//
// Only the latest guess per chat matters, and it goes stale the moment the next
// turn starts — the composer would otherwise offer an answer to a reply the user
// has already moved past. Process-local: a restart starts with none.

export interface PromptSuggestionChange {
  chatId: number
  /** Null when the chat no longer has one. */
  text: string | null
}

const suggestionByChat = new Map<number, string>()
const listeners = new Set<(change: PromptSuggestionChange) => void>()

export function setChatPromptSuggestion(chatId: number, text: string | null): void {
  if (text === null && !suggestionByChat.has(chatId)) return
  if (text !== null && suggestionByChat.get(chatId) === text) return
  if (text === null) suggestionByChat.delete(chatId)
  else suggestionByChat.set(chatId, text)
  for (const listener of listeners) {
    try {
      listener({ chatId, text })
    } catch (err) {
      console.error('[PromptSuggestions] subscriber failed:', err)
    }
  }
}

export function subscribePromptSuggestions(listener: (change: PromptSuggestionChange) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Every chat holding a suggestion, for a stream's connect-time snapshot. */
export function listChatPromptSuggestions(): Array<{ chatId: number; text: string }> {
  return [...suggestionByChat.entries()].map(([chatId, text]) => ({ chatId, text }))
}
