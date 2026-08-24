import { create } from "zustand"
import { useEditorStore } from "@/stores/editor-store"

/**
 * Which conversation the browser panel is currently showing.
 *
 * ## Why this exists
 * The browser panel is scoped to a conversation: switch chats and its pages change
 * with you. That mirrors codex, where the browser sidebar *is* that conversation's
 * browser (`routeKey = ${windowId}:${conversationId}` → its own `hostsByRouteKey`
 * entry). operon has one browser surface shared by every chat, so the scoping has to
 * be explicit: each page carries an owner chat id, and the panel shows only the
 * pages whose owner is in scope.
 *
 * ## Why it's sticky
 * It follows the active chat, but **keeps the last one** when no chat is active
 * (you opened the Board, or Settings). Dropping to "no browser" there would make
 * pages appear to vanish the moment you glance somewhere else, and come back when
 * you return — worse than simply staying put.
 *
 * `undefined` only before you have ever opened a chat.
 */
interface BrowserScopeState {
  chatId?: number
}

export const useBrowserScopeStore = create<BrowserScopeState>(() => ({
  chatId: undefined,
}))

/** Current browser scope, outside React (tab-entries stamps new pages with it). */
export const browserScopeChatId = (): number | undefined =>
  useBrowserScopeStore.getState().chatId

const activeChatIdOf = (s: ReturnType<typeof useEditorStore.getState>): number | undefined =>
  s.tabs.find((t) => t.id === s.activeTabId)?.chatId

/**
 * Follow the editor's active chat. Sticky: a chat-less active tab (diff, terminal)
 * or no tab at all leaves the scope where it was — see "Why it's sticky" above.
 */
useEditorStore.subscribe((s) => {
  const chatId = activeChatIdOf(s)
  if (chatId == null) return
  if (useBrowserScopeStore.getState().chatId === chatId) return
  useBrowserScopeStore.setState({ chatId })
})

// Seed from whatever is already open (the subscription only fires on change).
{
  const chatId = activeChatIdOf(useEditorStore.getState())
  if (chatId != null) useBrowserScopeStore.setState({ chatId })
}
