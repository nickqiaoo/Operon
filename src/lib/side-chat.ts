import type { Tab } from "@/components/app-shell/tabs/types"
import { apiFor } from "@/lib/api"
import { chatTabId, type ChatRef } from "@/lib/chat-ref"
import { useAppShellStore } from "@/stores/app-shell-store"
import { useEditorStore } from "@/stores/editor-store"
import { useTabsStore } from "@/stores/tabs-store"

/**
 * Open a side chat: a temporary branch of `parentChatId`'s conversation, shown
 * as a tab in the right panel.
 *
 * The branch is a snapshot. The forked session inherits the parent's history as
 * model context, but the two diverge from here — nothing said in the parent
 * afterwards reaches this side chat, and vice versa. Closing the tab discards it.
 *
 * The chat row is created before the fork so the tab has something to render
 * against straight away; the provider session is forked server-side on the first
 * turn, so a side chat the user opens and abandons never costs one.
 */
export async function openSideChat(
  parent: ChatRef,
  options: { providerId?: string } = {}
): Promise<number | null> {
  // The fork is made on the machine the parent lives on, and lives there.
  const { nodeId, chatId: parentChatId } = parent
  const api = apiFor(nodeId)
  const panelTabs = useTabsStore.getState()
  const title = nextSideChatTitle(panelTabs.right.tabs)

  const created = await api.chatHistorySideCreate(parentChatId, title)
  if (!created.success || created.chatId == null) {
    throw new Error(created.error ?? "Failed to open side chat")
  }
  const chatId = created.chatId

  // ChatPanel reads a conversation's state out of the editor store, so the side
  // chat needs a record there even though it never appears in the tab strip.
  const ref: ChatRef = nodeId ? { nodeId, chatId } : { chatId }
  useEditorStore.getState().openSideChatTab(ref, title, options.providerId)

  const tab: Tab = {
    tabId: sideChatTabId(ref),
    title,
    isClosable: true,
    payload: { type: "side-chat", chatId, parentChatId, ...(nodeId ? { nodeId } : {}) },
  }
  panelTabs.openTab("right", tab)
  useAppShellStore.getState().setRightPanelOpen(true)
  return chatId
}

/**
 * Discard a side chat when its tab closes. A side chat is temporary by design —
 * it holds no history worth keeping and its forked provider session was created
 * ephemeral — so closing the tab deletes the row rather than leaving an
 * unreachable conversation behind (nothing lists side chats).
 */
export function discardSideChat(chat: ChatRef): void {
  const { chatId } = chat
  const api = apiFor(chat.nodeId)
  // The editor-store record `openSideChatTab` created lives under `chat:<id>`.
  useEditorStore.getState().closeTab(chatTabId(chat))
  // Tear the forked provider session down too — the row is going away, so
  // nothing would ever reach that session again and it would sit on a live
  // codex thread until the app exits.
  void api
    .aiSessionCleanup(chatId)
    .catch(() => {})
    .finally(() => {
      void api.chatHistoryClear(chatId).catch((error) => {
        console.error("Failed to discard side chat", chatId, error)
      })
    })
}

/**
 * Whether this side chat has been used. Closing an untouched one throws nothing
 * away, so it skips the confirmation.
 */
export async function sideChatHasMessages(chat: ChatRef): Promise<boolean> {
  const { chatId } = chat
  try {
    const page = await apiFor(chat.nodeId).chatHistoryGet(chatId, { limit: 1 })
    return (page.total ?? page.messages.length) > 0
  } catch (error) {
    // Can't tell — confirm rather than silently discard.
    console.error("Failed to read side chat history", chatId, error)
    return true
  }
}

export const SIDE_CHAT_TAB_PREFIX = "sidechat:"

export const sideChatTabId = (chat: ChatRef): string =>
  `${SIDE_CHAT_TAB_PREFIX}${chat.nodeId ? `${chat.nodeId}:` : ""}${chat.chatId}`

/** "Side chat", then "Side chat 2" — counted over the tabs already in the panel. */
function nextSideChatTitle(tabs: Tab[]): string {
  const count = tabs.filter((tab) => tab.payload.type === "side-chat").length
  return count === 0 ? "Side chat" : `Side chat ${count + 1}`
}
