import { useMemo } from "react"
import { useTabsStore } from "@/stores/tabs-store"
import { useBrowserScopeStore } from "@/stores/browser-scope-store"
import type { PanelId, Tab } from "./types"

/**
 * The tabs a panel should actually show, and which of them is active.
 *
 * ## Why panels filter instead of just rendering `panel.tabs`
 * The browser is scoped to a conversation: switch chats and its pages switch with
 * you. That mirrors codex, where the browser sidebar *is* that conversation's
 * browser (`routeKey = ${windowId}:${conversationId}`, its own `hostsByRouteKey`
 * entry). operon has one browser surface shared by every chat, so scoping is a view
 * concern: pages stay in the store, we only show the ones in scope. Keeping them in
 * the store is deliberate — `browserManager` reaps a webview when its tab leaves the
 * store, and switching chats must not destroy the other chat's pages.
 *
 * Only `browser` tabs are scoped. Terminals, diffs and file trees belong to the
 * workspace, not to a conversation, and are always shown.
 *
 * Ownerless browser pages (opened before any chat existed) are shown in every scope.
 * They are nobody's, so hiding them would just lose them — and no agent can drive
 * them either (Browser Use only sees pages whose owner is its own session).
 */
export function useVisiblePanelTabs(panelId: PanelId): {
  tabs: Tab[]
  activeTabId: string | null
} {
  const panel = useTabsStore((s) => s[panelId])
  const scopeChatId = useBrowserScopeStore((s) => s.chatId)

  return useMemo(() => {
    const tabs = panel.tabs.filter(
      (t) =>
        t.payload.type !== "browser" ||
        t.payload.chatId == null ||
        t.payload.chatId === scopeChatId
    )
    // The stored active tab may belong to another conversation now. Fall back to the
    // last visible tab rather than showing an empty panel next to a full tab strip.
    const activeTabId = tabs.some((t) => t.tabId === panel.activeTabId)
      ? panel.activeTabId
      : (tabs[tabs.length - 1]?.tabId ?? null)
    return { tabs, activeTabId }
  }, [panel, scopeChatId])
}
